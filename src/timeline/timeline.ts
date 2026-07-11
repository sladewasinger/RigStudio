/**
 * Keyframe timeline: clip selector, transport controls (speed, ping-pong, onion skin),
 * a scrubber ruler, and one lane per animated track with draggable keyframe diamonds.
 *
 * Keyframe editing: click selects a diamond (Shift+click adds, drag on empty lane space
 * box-selects), dragging retimes the whole selection, double-click deletes. A property
 * row above the lanes edits the selected keys' time/value/easing. Ctrl+C / Ctrl+V copy
 * and paste keyframes at the playhead (wired from main.ts), arrow keys nudge them.
 *
 * The whole panel is disabled in Setup mode — keyframes only exist in Animate mode.
 *
 * Panel shell: #timeline has a FIXED height (splitter-adjustable, localStorage-
 * persisted) set via inline style in applyPanelHeight — never CSS min/max-content
 * sizing. This is a P3 bug fix: a lane appearing mid-drag used to grow #timeline's
 * intrinsic height, shrinking #layout/#canvas in the same flex column and shifting
 * the canvas's screen CTM under an in-flight gesture (a 30° rotate recorded ~12°).
 * render() only ever touches `bodyEl` (an internally-scrolling child) — the chip
 * header and splitter live outside it, built once in setupShell().
 */

import {
  state, notify, activeClip, deleteKeyframe, Track, Keyframe, EASINGS, Easing,
  copyKeys, pasteKeysAt, copyPoseAt, clipboardSize,
} from '../core/model';
import { renderPose } from '../view';
import { checkpoint } from '../core/history';
import { buildGraphPanel, onGraphChange } from './graph';
import { buildSMPanel, stopPreview, setLogicVisible } from '../panels/smPanel';
import { dialog } from '../ui/dialogs';
import './timeline.css';

let container: HTMLElement;
// The scrolling content region inside the fixed-height shell — render() rebuilds
// only this, never `container` itself, so panel height never depends on content.
let bodyEl: HTMLElement;
let rafId = 0;
let lastTick = 0;
let fpsFrames = 0;
let fpsWindowStart = 0;
let fpsValue = 0;

// Selected keyframes (live object references into the active clip). Pruned on render;
// cleared wholesale when undo/redo swaps the document out from under us.
let selectedKeys = new Set<Keyframe>();
let trackOfKey = new WeakMap<Keyframe, Track>();
// Diamond elements of the current render, for box-select hit testing.
let diamondEls: { el: HTMLElement; key: Keyframe }[] = [];
// Which content replaces the lanes area — mutually exclusive by construction (a
// single field, not two booleans that could disagree). Onion is a separate toggle.
type PanelMode = 'keys' | 'curves' | 'logic';
let panelMode: PanelMode = 'keys';

// ---- Panel height (splitter, item 2) ----

export const TIMELINE_HEIGHT_KEY = 'rig-studio-timeline-height';
const MIN_HEIGHT = 120;
const MAX_HEIGHT_VH = 0.7;
// "...the current typical height" (the spec's fallback phrasing): the OLD min-height
// floor. Setup mode's auto-sized content (just a note) always hit that floor, and
// Setup is the default/reset state, so this is the footprint most of the app's screen
// real estate was already tuned around. A 30vh default (~240px at a typical 800px
// viewport) was tried first and rejected: it shrank #canvas to roughly half its old
// boot-time height, silently invalidating pixel-based interaction-test gestures
// (including ones outside this file's ownership) that assumed the old geometry.
const DEFAULT_HEIGHT = MIN_HEIGHT;

function maxHeightPx(): number {
  return Math.max(MIN_HEIGHT, window.innerHeight * MAX_HEIGHT_VH);
}

function clampHeight(px: number): number {
  return Math.min(maxHeightPx(), Math.max(MIN_HEIGHT, px));
}

/** Sets every box-model property that could let content dictate the panel's height,
 *  overriding style.css's #timeline min/max-height block via inline style (which wins
 *  over any external stylesheet rule regardless of load order — the one thing this
 *  fix cannot afford to lose to a cascade-order accident). */
function applyPanelHeight(px: number): void {
  const h = clampHeight(px);
  container.style.flex = '0 0 auto';
  container.style.height = `${h}px`;
  container.style.minHeight = '0';
  container.style.maxHeight = 'none';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.overflow = 'hidden'; // .tl-body scrolls internally instead
}

function loadStoredHeight(): number {
  const raw = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEIGHT;
}

function saveHeight(px: number): void {
  localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(px)));
}

function wireSplitter(): void {
  const splitter = document.getElementById('timeline-splitter');
  if (!splitter) return;
  splitter.addEventListener('pointerdown', (ev) => {
    const pev = ev as PointerEvent;
    pev.preventDefault();
    const startY = pev.clientY;
    const startHeight = container.getBoundingClientRect().height;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    try { splitter.setPointerCapture(pev.pointerId); } catch { /* synthetic/pen events */ }
    const move = (e: PointerEvent) => {
      // The panel sits at the bottom: dragging UP (negative dy) must GROW it.
      applyPanelHeight(startHeight - (e.clientY - startY));
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveHeight(container.getBoundingClientRect().height);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

/** Built once (not by render()): the fixed-height shell, the "Timeline" chip, the
 *  scrolling body, and the splitter. */
function setupShell(): void {
  applyPanelHeight(loadStoredHeight());
  wireSplitter();
  window.addEventListener('resize', () => {
    const current = container.getBoundingClientRect().height;
    const clamped = clampHeight(current);
    if (Math.abs(clamped - current) > 0.5) applyPanelHeight(clamped);
  });

  const chip = div('tl-chip');
  chip.textContent = 'Timeline';
  container.appendChild(chip);

  bodyEl = div('tl-body');
  container.appendChild(bodyEl);
}

export function buildTimeline(el: HTMLElement): void {
  container = el;
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

/** Space-bar hook (from main.ts). */
export function togglePlay(): void {
  if (!activeClip() || state.editorMode !== 'animate') return;
  state.playing = !state.playing;
  if (state.playing) startPlayback();
  render();
}

// ---- Keyframe selection & clipboard (also driven by main.ts shortcuts) ----

export function hasKeySelection(): boolean {
  return selectedKeys.size > 0;
}

export function clearKeySelection(): void {
  selectedKeys.clear();
}

export function copySelectedKeys(): number {
  const entries = [...selectedKeys]
    .map((key) => ({ key, track: trackOfKey.get(key) }))
    .filter((e): e is { key: Keyframe; track: Track } => !!e.track);
  return copyKeys(entries.map(({ track, key }) => ({ track, key })));
}

export function pasteKeysAtPlayhead(): number {
  if (clipboardSize() === 0 || state.editorMode !== 'animate') return 0;
  checkpoint();
  const pasted = pasteKeysAt(Math.round(state.currentTime / 10) * 10);
  selectedKeys = new Set(pasted);
  notify();
  renderPose();
  return pasted.length;
}

export function deleteSelectedKeys(): void {
  if (selectedKeys.size === 0) return;
  checkpoint();
  for (const key of selectedKeys) {
    const track = trackOfKey.get(key);
    if (track) deleteKeyframe(track, key);
  }
  selectedKeys.clear();
  notify();
  renderPose();
}

/** Move the selected keys by dt ms. Returns false when nothing is selected. */
export function nudgeSelectedKeys(dt: number): boolean {
  if (selectedKeys.size === 0) return false;
  checkpoint();
  const clip = activeClip();
  for (const key of selectedKeys) {
    key.time = Math.max(0, Math.min(clip?.duration ?? Infinity, key.time + dt));
  }
  for (const key of selectedKeys) {
    trackOfKey.get(key)?.keyframes.sort((a, b) => a.time - b.time);
  }
  notify();
  renderPose();
  return true;
}

/** Select every keyframe at (±5 ms) the playhead — a column across all lanes. */
export function selectColumnAtPlayhead(): void {
  const clip = activeClip();
  if (!clip) return;
  selectedKeys.clear();
  for (const track of clip.tracks) {
    for (const key of track.keyframes) {
      if (Math.abs(key.time - state.currentTime) <= 5) selectedKeys.add(key);
    }
  }
  render();
}

export function render(): void {
  if (!container || !bodyEl) return;
  bodyEl.innerHTML = '';
  container.classList.toggle('disabled', state.editorMode !== 'animate');
  // The logic (state-machine) view + its live preview only exist in Animate mode with a
  // doc. Any time it is NOT on screen, tear the preview down (restores the pose sampler).
  const showingLogic = !!state.doc && state.editorMode === 'animate' && panelMode === 'logic';
  if (!showingLogic) {
    stopPreview();
    setLogicVisible(false);
  }
  const doc = state.doc;
  if (!doc) {
    bodyEl.innerHTML = '<div class="tl-empty">Import an SVG to start animating.</div>';
    return;
  }
  if (state.editorMode !== 'animate') {
    const note = div('tl-setup-note');
    note.innerHTML =
      'Edit mode — you are editing the character\'s rest pose, pivots, and paths. ' +
      'Switch to <b>Animate</b> (top right) to record keyframes.';
    bodyEl.appendChild(note);
    return;
  }
  const clip = activeClip();

  // Prune selection: drop keys that no longer exist (deleted, undone, clip switched).
  if (clip) {
    const live = new Set<Keyframe>();
    trackOfKey = new WeakMap();
    for (const track of clip.tracks) {
      for (const key of track.keyframes) {
        trackOfKey.set(key, track);
        if (selectedKeys.has(key)) live.add(key);
      }
    }
    selectedKeys = live;
  } else {
    selectedKeys.clear();
  }
  diamondEls = [];

  // --- Transport bar: transport | clip management | modes | toggles clusters ---
  const bar = div('tl-bar');

  // Cluster: transport (jump/step/play + speed + fps/time readouts).
  const transportCluster = div('tl-cluster tl-transport');
  transportCluster.setAttribute('role', 'group');
  transportCluster.setAttribute('aria-label', 'Transport');

  const jumpStartBtn = button('⏮', () => clip && movePlayheadTo(0, clip.duration));
  jumpStartBtn.title = 'Jump to start';
  jumpStartBtn.dataset.tlAction = 'jump-start';
  jumpStartBtn.disabled = !clip;
  transportCluster.appendChild(jumpStartBtn);

  const stepBackBtn = button('◀', () => clip && movePlayheadTo(Math.max(0, state.currentTime - 10), clip.duration));
  stepBackBtn.title = 'Step back 10 ms';
  stepBackBtn.dataset.tlAction = 'step-back';
  stepBackBtn.disabled = !clip;
  transportCluster.appendChild(stepBackBtn);

  const playBtn = button(state.playing ? '⏸' : '▶', togglePlay);
  playBtn.classList.add('tl-play');
  playBtn.title = 'Space';
  playBtn.dataset.tlAction = 'play';
  transportCluster.appendChild(playBtn);

  const stepFwdBtn = button('▶|', () => clip && movePlayheadTo(Math.min(clip.duration, state.currentTime + 10), clip.duration));
  stepFwdBtn.title = 'Step forward 10 ms';
  stepFwdBtn.dataset.tlAction = 'step-fwd';
  stepFwdBtn.disabled = !clip;
  transportCluster.appendChild(stepFwdBtn);

  const jumpEndBtn = button('⏭', () => clip && movePlayheadTo(clip.duration, clip.duration));
  jumpEndBtn.title = 'Jump to end';
  jumpEndBtn.dataset.tlAction = 'jump-end';
  jumpEndBtn.disabled = !clip;
  transportCluster.appendChild(jumpEndBtn);

  const speed = document.createElement('select');
  speed.className = 'tl-speed';
  for (const s of [0.1, 0.25, 0.5, 1, 1.5, 2, 4]) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = `${s}×`;
    if (s === state.playbackSpeed) opt.selected = true;
    speed.appendChild(opt);
  }
  speed.onchange = () => {
    state.playbackSpeed = Number(speed.value);
  };
  speed.title = 'Playback speed';
  transportCluster.appendChild(speed);

  const fpsEl = div('tl-fps');
  fpsEl.textContent = state.playing && fpsValue > 0 ? `${fpsValue} fps` : '';
  transportCluster.appendChild(fpsEl);

  const timeLabel = div('tl-time');
  timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
  transportCluster.appendChild(timeLabel);

  bar.appendChild(transportCluster);

  // Cluster: clip management.
  const clipCluster = div('tl-cluster tl-clip-mgmt');
  clipCluster.setAttribute('role', 'group');
  clipCluster.setAttribute('aria-label', 'Animation clip');

  const clipSelect = document.createElement('select');
  doc.clips.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = c.name;
    if (i === state.activeClipIndex) opt.selected = true;
    clipSelect.appendChild(opt);
  });
  clipSelect.onchange = () => {
    state.activeClipIndex = Number(clipSelect.value);
    state.currentTime = 0;
    selectedKeys.clear();
    notify();
    renderPose();
  };
  clipCluster.appendChild(clipSelect);

  clipCluster.appendChild(button('+ animation', async () => {
    const name = await dialog.prompt('Animation name?', `clip_${doc.clips.length + 1}`);
    if (!name) return;
    checkpoint();
    doc.clips.push({ name, duration: 2000, tracks: [] });
    state.activeClipIndex = doc.clips.length - 1;
    state.currentTime = 0;
    notify();
  }));

  clipCluster.appendChild(button('duplicate', () => {
    if (!clip) return;
    checkpoint();
    const copy = structuredClone(clip);
    copy.name = `${clip.name}_copy`;
    doc.clips.push(copy);
    state.activeClipIndex = doc.clips.length - 1;
    notify();
  }));

  clipCluster.appendChild(button('rename', async () => {
    if (!clip) return;
    const name = await dialog.prompt('New clip name?', clip.name);
    if (name) {
      checkpoint();
      clip.name = name;
      notify();
    }
  }));

  clipCluster.appendChild(button('delete', async () => {
    if (!clip || doc.clips.length <= 1) return;
    if (!await dialog.confirm(`Delete animation "${clip.name}"?`)) return;
    checkpoint();
    doc.clips.splice(state.activeClipIndex, 1);
    state.activeClipIndex = 0;
    notify();
  }));

  if (clip) {
    const durLabel = document.createElement('label');
    durLabel.textContent = 'duration (ms)';
    const dur = document.createElement('input');
    dur.type = 'number';
    dur.value = String(clip.duration);
    dur.step = '100';
    dur.onchange = () => {
      checkpoint();
      clip.duration = Math.max(100, Number(dur.value));
      notify();
    };
    durLabel.appendChild(dur);
    clipCluster.appendChild(durLabel);

    // Loop is DOC data (serialized, undoable) — unlike ping-pong below, which is an
    // app-state PREVIEW preference shared across every clip. This flag instead drives
    // the state-machine evaluator (a non-looping clip's clock clamps at its end, so an
    // exit-time transition can fire once and only once past it) and the .riv export's
    // LinearAnimation loopValue. The timeline's own scrub/playback preview keeps
    // looping regardless — that's transport behavior, not this flag.
    const loopBtn = button('↻ loop', () => {
      checkpoint();
      clip.loop = !(clip.loop !== false);
      notify();
    });
    loopBtn.dataset.tlAction = 'clip-loop';
    if (clip.loop !== false) loopBtn.classList.add('active');
    loopBtn.title = 'Loop this clip in the state machine / .riv export (playback preview always loops)';
    clipCluster.appendChild(loopBtn);
  }

  bar.appendChild(clipCluster);

  // Cluster: modes — Keys / Curves / Logic, mutually exclusive by construction.
  const modeCluster = div('tl-cluster tl-modes');
  modeCluster.setAttribute('role', 'group');
  modeCluster.setAttribute('aria-label', 'Panel mode');
  const modePicker = div('tl-mode-picker');
  modePicker.setAttribute('role', 'radiogroup');
  modePicker.setAttribute('aria-label', 'Timeline mode');
  const modeDefs: { key: PanelMode; label: string; title: string }[] = [
    { key: 'keys', label: '⏱ keys', title: 'Keyframe lanes' },
    { key: 'curves', label: '📈 curves', title: "Edit the selected track's value curve and per-segment bezier easing" },
    { key: 'logic', label: '🔀 logic', title: 'Build interactive state machines that blend your clips' },
  ];
  for (const m of modeDefs) {
    const b = button(m.label, () => setMode(m.key));
    b.title = m.title;
    b.dataset.tlAction = `mode-${m.key}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(panelMode === m.key));
    if (panelMode === m.key) b.classList.add('active');
    modePicker.appendChild(b);
  }
  modeCluster.appendChild(modePicker);
  bar.appendChild(modeCluster);

  // Cluster: toggles (ping-pong, onion — independent of panelMode).
  const togglesCluster = div('tl-cluster tl-toggles');
  togglesCluster.setAttribute('role', 'group');
  togglesCluster.setAttribute('aria-label', 'Playback toggles');

  const pingPongBtn = button('⇄ ping-pong', () => {
    state.pingPong = !state.pingPong;
    state.playDirection = 1;
    render();
  });
  if (state.pingPong) pingPongBtn.classList.add('active');
  pingPongBtn.title = 'Bounce playback back and forth instead of looping';
  togglesCluster.appendChild(pingPongBtn);

  const onionBtn = button('🧅 onion', () => {
    state.onionSkin = !state.onionSkin;
    render();
    renderPose();
  });
  if (state.onionSkin) onionBtn.classList.add('active');
  onionBtn.title = 'Ghost the previous (red) and next (blue) keyed poses';
  togglesCluster.appendChild(onionBtn);

  bar.appendChild(togglesCluster);

  bodyEl.appendChild(bar);
  bodyEl.appendChild(divider());

  // Logic view swaps the whole lanes area for the state-machine editor (mutually
  // exclusive with curves; needs no clip, so it precedes the no-clip bail-out).
  if (panelMode === 'logic') {
    setLogicVisible(true);
    const smHost = div('sm-panel-host');
    bodyEl.appendChild(smHost);
    buildSMPanel(smHost);
    return;
  }

  if (!clip) return;

  // --- Keyframe utility row ---
  const keyBar = div('tl-keybar');
  keyBar.appendChild(button('copy pose', () => {
    const n = copyPoseAt(state.currentTime);
    flash(keyBar, n ? `copied pose (${n} channels)` : 'no animated channels');
  }));
  keyBar.appendChild(button('select column', selectColumnAtPlayhead));
  const pasteBtn = button('paste @ playhead', () => {
    const n = pasteKeysAtPlayhead();
    flash(keyBar, n ? `pasted ${n} key${n === 1 ? '' : 's'}` : 'clipboard empty');
  });
  pasteBtn.disabled = clipboardSize() === 0;
  keyBar.appendChild(pasteBtn);

  if (selectedKeys.size > 0) {
    const info = document.createElement('span');
    info.className = 'tl-keyinfo';
    info.textContent = `${selectedKeys.size} key${selectedKeys.size === 1 ? '' : 's'}`;
    keyBar.appendChild(info);

    if (selectedKeys.size === 1) {
      const key = [...selectedKeys][0];
      const timeIn = document.createElement('input');
      timeIn.type = 'number';
      timeIn.step = '10';
      timeIn.value = String(key.time);
      timeIn.title = 'Keyframe time (ms)';
      timeIn.onchange = () => {
        checkpoint();
        key.time = Math.max(0, Number(timeIn.value));
        trackOfKey.get(key)?.keyframes.sort((a, b) => a.time - b.time);
        notify();
        renderPose();
      };
      keyBar.appendChild(timeIn);

      const valIn = document.createElement('input');
      valIn.type = 'number';
      valIn.step = 'any';
      valIn.value = String(key.value);
      valIn.title = 'Keyframe value';
      valIn.onchange = () => {
        checkpoint();
        key.value = Number(valIn.value);
        notify();
        renderPose();
      };
      keyBar.appendChild(valIn);
    }

    const easingSel = document.createElement('select');
    easingSel.title = 'Easing of the segment arriving at the key';
    const values = new Set([...selectedKeys].map((k) => k.easing));
    if (values.size > 1) {
      const mixed = document.createElement('option');
      mixed.value = '';
      mixed.textContent = '(mixed)';
      mixed.selected = true;
      easingSel.appendChild(mixed);
    }
    for (const e of EASINGS) {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      if (values.size === 1 && values.has(e)) opt.selected = true;
      easingSel.appendChild(opt);
    }
    easingSel.onchange = () => {
      if (!easingSel.value) return;
      checkpoint();
      for (const key of selectedKeys) key.easing = easingSel.value as Easing;
      notify();
      renderPose();
    };
    keyBar.appendChild(easingSel);

    keyBar.appendChild(button('delete keys', deleteSelectedKeys));
  } else {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent =
      'Click a diamond to select · drag empty lane space to box-select · Ctrl+C/V copy/paste';
    keyBar.appendChild(hint);
  }
  bodyEl.appendChild(keyBar);
  bodyEl.appendChild(divider());

  // --- Ruler + lanes ---
  const lanes = div('tl-lanes');
  // Catch-all: the blank gutter to the left of the ruler (above row 1, left of the
  // label column) is the `lanes` container's own background, not covered by any
  // child — mark it a boxTarget too so a marquee can start from the very top-left.
  lanes.dataset.boxTarget = '1';

  const ruler = div('tl-ruler');
  const playhead = div('tl-playhead');
  playhead.style.left = `${(state.currentTime / clip.duration) * 100}%`;
  ruler.appendChild(playhead);
  const scrub = (ev: PointerEvent) => {
    const rect = ruler.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    state.currentTime = Math.round(frac * clip.duration);
    playhead.style.left = `${frac * 100}%`;
    const timeEl = container.querySelector<HTMLElement>('.tl-time');
    if (timeEl) timeEl.textContent = `${Math.round(state.currentTime)} ms`;
    renderPose();
  };
  ruler.addEventListener('pointerdown', (ev) => {
    try { ruler.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
    scrub(ev);
    const move = (e: PointerEvent) => scrub(e);
    const up = () => {
      ruler.removeEventListener('pointermove', move);
      ruler.removeEventListener('pointerup', up);
      notify();
    };
    ruler.addEventListener('pointermove', move);
    ruler.addEventListener('pointerup', up);
  });
  lanes.appendChild(ruler);

  // Generous padding ABOVE the lane block: a marquee can start here (dataset.boxTarget)
  // without touching the ruler above it, so a loose drag from just under the scrubber
  // still box-selects instead of missing entirely.
  lanes.appendChild(padRow());

  clip.tracks.forEach((track, i) => lanes.appendChild(buildLane(track, clip.duration, i)));
  if (clip.tracks.length === 0) {
    const hint = div('tl-empty');
    hint.textContent = 'Pose a part on the canvas to record keyframes at the playhead.';
    lanes.appendChild(hint);
  }

  // ...and generous padding BELOW it, so a marquee can end past the last lane.
  lanes.appendChild(padRow());

  wireBoxSelect(lanes);
  bodyEl.appendChild(lanes);

  if (panelMode === 'curves') {
    bodyEl.appendChild(divider());
    const graphHost = div('graph-panel');
    const first = [...selectedKeys][0];
    const track = (first && trackOfKey.get(first)) ?? clip.tracks[0] ?? null;
    buildGraphPanel(graphHost, track, clip.duration);
    bodyEl.appendChild(graphHost);
  }
}

function setMode(next: PanelMode): void {
  if (panelMode === next) return;
  if (panelMode === 'logic') stopPreview();
  panelMode = next;
  render();
}

function padRow(): HTMLElement {
  const pad = div('tl-lanes-pad');
  pad.dataset.boxTarget = '1';
  return pad;
}

function buildLane(track: Track, duration: number, index: number): HTMLElement {
  const doc = state.doc!;
  const lane = div('tl-lane');
  if (index % 2 === 1) lane.classList.add('tl-lane-alt');
  // The row itself is marquee territory too (not just the thin strip), so a loosely
  // aimed drag inside the row's own vertical padding still starts a box-select.
  lane.dataset.boxTarget = '1';
  const label = div('tl-lane-label');
  // Bug fix: the label is display-only text, but it's still the pointerdown TARGET
  // when a drag starts directly over it (the lane's own boxTarget only helps when the
  // hit lands on the row's padding, not the label element itself) — without this the
  // gate in wireBoxSelect fell through and the browser started native text selection
  // instead of the marquee. Marking it a boxTarget feeds it the same as the gap/strip.
  label.dataset.boxTarget = '1';
  const partLabel =
    track.target === 'root' ? 'root' : (doc.parts.find((p) => p.id === track.target)?.label ?? '?');
  label.textContent = `${partLabel}.${track.channel}`;
  lane.appendChild(label);

  // Gap between the label gutter and the strip: generous padding so a marquee can
  // start slightly left of time 0 without landing on the label text.
  const gap = div('tl-lane-gap');
  gap.dataset.boxTarget = '1';
  lane.appendChild(gap);

  const strip = div('tl-strip');
  strip.dataset.boxTarget = '1';
  for (const key of track.keyframes) {
    const diamond = div('tl-key');
    diamond.style.left = `${(key.time / duration) * 100}%`;
    if (selectedKeys.has(key)) diamond.classList.add('selected');
    diamond.title =
      `${key.time} ms = ${key.value} · ${key.easing}\n` +
      'click: select · drag: retime · double-click: delete';
    diamondEls.push({ el: diamond, key });
    diamond.addEventListener('dblclick', () => {
      checkpoint();
      selectedKeys.delete(key);
      deleteKeyframe(track, key);
      notify();
      renderPose();
    });
    diamond.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      // Selection first: plain click selects this key; Shift toggles membership; a key
      // already in the selection keeps the group (so dragging moves them all).
      if (ev.shiftKey) {
        if (selectedKeys.has(key)) selectedKeys.delete(key);
        else selectedKeys.add(key);
      } else if (!selectedKeys.has(key)) {
        selectedKeys.clear();
        selectedKeys.add(key);
      }
      // Scrub to the clicked key so the canvas shows the pose it records.
      movePlayheadTo(key.time, duration);

      let pendingCheckpoint = true; // defer until real movement, not a plain click
      let moved = false;
      const startTimes = new Map<Keyframe, number>([...selectedKeys].map((k) => [k, k.time]));
      const grabTime = key.time;
      try { diamond.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
      const move = (e: PointerEvent) => {
        if (pendingCheckpoint) {
          checkpoint();
          pendingCheckpoint = false;
        }
        moved = true;
        const rect = strip.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const newTime = Math.round((frac * duration) / 10) * 10;
        const dt = newTime - grabTime;
        for (const [k, t0] of startTimes) {
          k.time = Math.min(duration, Math.max(0, Math.round((t0 + dt) / 10) * 10));
        }
        // Reposition every selected diamond in place — a full render() would destroy
        // the element currently holding pointer capture and kill the drag.
        for (const d of diamondEls) {
          if (startTimes.has(d.key)) d.el.style.left = `${(d.key.time / duration) * 100}%`;
        }
        // The playhead follows the grabbed key, previewing the pose as it retimes.
        movePlayheadTo(key.time, duration);
      };
      const up = () => {
        diamond.removeEventListener('pointermove', move);
        diamond.removeEventListener('pointerup', up);
        if (moved) {
          for (const k of startTimes.keys()) {
            trackOfKey.get(k)?.keyframes.sort((a, b) => a.time - b.time);
          }
        }
        notify();
        renderPose();
      };
      diamond.addEventListener('pointermove', move);
      diamond.addEventListener('pointerup', up);
    });
    strip.appendChild(diamond);
  }
  lane.appendChild(strip);
  return lane;
}

/** Marquee selection across lanes: drag on empty strip space, select touched diamonds. */
function wireBoxSelect(lanes: HTMLElement): void {
  lanes.addEventListener('pointerdown', (ev) => {
    const target = ev.target as HTMLElement;
    // Only from marquee territory (row padding, the label↔strip gap, the strip itself,
    // or the padding rows above/below the block) — diamonds and the ruler handle their
    // own drags and are never marked boxTarget.
    if (!target.dataset.boxTarget) return;
    ev.preventDefault();
    const origin = { x: ev.clientX, y: ev.clientY };
    const marquee = div('tl-marquee');
    lanes.appendChild(marquee);
    const lanesRect = lanes.getBoundingClientRect();

    const update = (e: PointerEvent) => {
      const x0 = Math.min(origin.x, e.clientX), x1 = Math.max(origin.x, e.clientX);
      const y0 = Math.min(origin.y, e.clientY), y1 = Math.max(origin.y, e.clientY);
      marquee.style.left = `${x0 - lanesRect.left}px`;
      marquee.style.top = `${y0 - lanesRect.top}px`;
      marquee.style.width = `${x1 - x0}px`;
      marquee.style.height = `${y1 - y0}px`;
      return { x0, x1, y0, y1 };
    };
    update(ev);

    try { lanes.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
    const move = (e: PointerEvent) => update(e);
    const up = (e: PointerEvent) => {
      lanes.removeEventListener('pointermove', move);
      lanes.removeEventListener('pointerup', up);
      const { x0, x1, y0, y1 } = update(e);
      marquee.remove();
      if (!e.shiftKey) selectedKeys.clear();
      for (const { el, key } of diamondEls) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) selectedKeys.add(key);
      }
      render();
    };
    lanes.addEventListener('pointermove', move);
    lanes.addEventListener('pointerup', up);
  });
}

function startPlayback(): void {
  cancelAnimationFrame(rafId);
  lastTick = performance.now();
  fpsFrames = 0;
  fpsWindowStart = lastTick;
  const step = (now: number) => {
    if (!state.playing) return;
    const clip = activeClip();
    if (!clip) return;

    const advance = (now - lastTick) * state.playbackSpeed;
    lastTick = now;
    let t = state.currentTime + advance * state.playDirection;
    if (state.pingPong) {
      // Bounce off both ends (may bounce twice on a long frame).
      while (t > clip.duration || t < 0) {
        if (t > clip.duration) {
          t = 2 * clip.duration - t;
          state.playDirection = -1;
        } else {
          t = -t;
          state.playDirection = 1;
        }
      }
    } else {
      t = ((t % clip.duration) + clip.duration) % clip.duration;
    }
    state.currentTime = t;

    fpsFrames += 1;
    if (now - fpsWindowStart >= 500) {
      fpsValue = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
      fpsFrames = 0;
      fpsWindowStart = now;
      const fpsEl = container.querySelector<HTMLElement>('.tl-fps');
      if (fpsEl) fpsEl.textContent = `${fpsValue} fps`;
    }

    renderPose();
    const playhead = container.querySelector<HTMLElement>('.tl-playhead');
    if (playhead) playhead.style.left = `${(state.currentTime / clip.duration) * 100}%`;
    const timeLabel = container.querySelector<HTMLElement>('.tl-time');
    if (timeLabel) timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

/** Scrub to a time and refresh the playhead/readout without a full rebuild. */
function movePlayheadTo(time: number, duration: number): void {
  state.currentTime = time;
  const playhead = container.querySelector<HTMLElement>('.tl-playhead');
  if (playhead) playhead.style.left = `${(time / duration) * 100}%`;
  const timeLabel = container.querySelector<HTMLElement>('.tl-time');
  if (timeLabel) timeLabel.textContent = `${Math.round(time)} ms`;
  renderPose();
}

/** Transient inline feedback in a bar (e.g. "copied pose (6 channels)"). */
function flash(host: HTMLElement, text: string): void {
  let el = host.querySelector<HTMLElement>('.tl-flash');
  if (!el) {
    el = document.createElement('span');
    el.className = 'tl-flash';
    host.appendChild(el);
  }
  el.textContent = text;
  setTimeout(() => el?.remove(), 1600);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function divider(): HTMLElement {
  return div('tl-divider');
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}
