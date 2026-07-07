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
 */

import {
  state, notify, activeClip, deleteKeyframe, Track, Keyframe, EASINGS, Easing,
  copyKeys, pasteKeysAt, copyPoseAt, clipboardSize,
} from './model';
import { renderPose } from './view';
import { checkpoint } from './history';

let container: HTMLElement;
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

export function buildTimeline(el: HTMLElement): void {
  container = el;
  document.addEventListener('rig-keys-changed', render);
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
  if (!container) return;
  container.innerHTML = '';
  container.classList.toggle('disabled', state.editorMode !== 'animate');
  const doc = state.doc;
  if (!doc) {
    container.innerHTML = '<div class="tl-empty">Import an SVG to start animating.</div>';
    return;
  }
  if (state.editorMode !== 'animate') {
    const note = div('tl-setup-note');
    note.innerHTML =
      'Setup mode — you are editing the character\'s rest pose, pivots, and paths. ' +
      'Switch to <b>Animate</b> (top right) to record keyframes.';
    container.appendChild(note);
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

  // --- Transport bar ---
  const bar = div('tl-bar');

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
  bar.appendChild(clipSelect);

  bar.appendChild(button('+ animation', () => {
    const name = prompt('Animation name?', `clip_${doc.clips.length + 1}`);
    if (!name) return;
    checkpoint();
    doc.clips.push({ name, duration: 2000, tracks: [] });
    state.activeClipIndex = doc.clips.length - 1;
    state.currentTime = 0;
    notify();
  }));

  bar.appendChild(button('duplicate', () => {
    if (!clip) return;
    checkpoint();
    const copy = structuredClone(clip);
    copy.name = `${clip.name}_copy`;
    doc.clips.push(copy);
    state.activeClipIndex = doc.clips.length - 1;
    notify();
  }));

  bar.appendChild(button('rename', () => {
    if (!clip) return;
    const name = prompt('New clip name?', clip.name);
    if (name) {
      checkpoint();
      clip.name = name;
      notify();
    }
  }));

  bar.appendChild(button('delete', () => {
    if (!clip || doc.clips.length <= 1) return;
    if (!confirm(`Delete animation "${clip.name}"?`)) return;
    checkpoint();
    doc.clips.splice(state.activeClipIndex, 1);
    state.activeClipIndex = 0;
    notify();
  }));

  const playBtn = button(state.playing ? '⏸' : '▶', togglePlay);
  playBtn.classList.add('tl-play');
  playBtn.title = 'Space';
  bar.appendChild(playBtn);

  // Playback speed
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
  bar.appendChild(speed);

  const pingPongBtn = button('⇄ ping-pong', () => {
    state.pingPong = !state.pingPong;
    state.playDirection = 1;
    render();
  });
  if (state.pingPong) pingPongBtn.classList.add('active');
  pingPongBtn.title = 'Bounce playback back and forth instead of looping';
  bar.appendChild(pingPongBtn);

  const onionBtn = button('🧅 onion', () => {
    state.onionSkin = !state.onionSkin;
    render();
    renderPose();
  });
  if (state.onionSkin) onionBtn.classList.add('active');
  onionBtn.title = 'Ghost the previous (red) and next (blue) keyed poses';
  bar.appendChild(onionBtn);

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
    bar.appendChild(durLabel);
  }

  const fpsEl = div('tl-fps');
  fpsEl.textContent = state.playing && fpsValue > 0 ? `${fpsValue} fps` : '';
  bar.appendChild(fpsEl);

  const timeLabel = div('tl-time');
  timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
  bar.appendChild(timeLabel);
  container.appendChild(bar);

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
  container.appendChild(keyBar);

  // --- Ruler + lanes ---
  const lanes = div('tl-lanes');

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

  for (const track of clip.tracks) {
    lanes.appendChild(buildLane(track, clip.duration));
  }
  if (clip.tracks.length === 0) {
    const hint = div('tl-empty');
    hint.textContent = 'Pose a part on the canvas to record keyframes at the playhead.';
    lanes.appendChild(hint);
  }
  wireBoxSelect(lanes);
  container.appendChild(lanes);
}

function buildLane(track: Track, duration: number): HTMLElement {
  const doc = state.doc!;
  const lane = div('tl-lane');
  const label = div('tl-lane-label');
  const partLabel =
    track.target === 'root' ? 'root' : (doc.parts.find((p) => p.id === track.target)?.label ?? '?');
  label.textContent = `${partLabel}.${track.channel}`;
  lane.appendChild(label);

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
    // Only from empty strip background — diamonds and the ruler handle their own drags.
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

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}
