/**
 * Keyframe timeline: clip selector, transport controls, a scrubber ruler, and one lane
 * per animated track with draggable keyframe diamonds (double-click a diamond to
 * delete it). Tracks appear automatically the first time a channel is keyed.
 */

import {
  state, notify, activeClip, deleteKeyframe, Track,
} from './model';
import { renderPose } from './view';
import { checkpoint } from './history';

let container: HTMLElement;
let rafId = 0;
let lastTick = 0;

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
  if (!activeClip()) return;
  state.playing = !state.playing;
  if (state.playing) startPlayback();
  render();
}

export function render(): void {
  if (!container) return;
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) {
    container.innerHTML = '<div class="tl-empty">Import an SVG to start animating.</div>';
    return;
  }
  const clip = activeClip();

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
    notify();
    renderPose();
  };
  bar.appendChild(clipSelect);

  bar.appendChild(button('+ clip', () => {
    const name = prompt('Clip name?', `clip_${doc.clips.length + 1}`);
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

  bar.appendChild(button('delete clip', () => {
    if (!clip || doc.clips.length <= 1) return;
    if (!confirm(`Delete clip "${clip.name}"?`)) return;
    checkpoint();
    doc.clips.splice(state.activeClipIndex, 1);
    state.activeClipIndex = 0;
    notify();
  }));

  const playBtn = button(state.playing ? '⏸' : '▶', togglePlay);
  playBtn.classList.add('tl-play');
  playBtn.title = 'Space';
  bar.appendChild(playBtn);

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

  const timeLabel = div('tl-time');
  timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
  bar.appendChild(timeLabel);
  container.appendChild(bar);

  if (!clip) return;

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
    timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
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
  for (const key of track.keyframes) {
    const diamond = div('tl-key');
    diamond.style.left = `${(key.time / duration) * 100}%`;
    diamond.title = `${key.time} ms = ${key.value} (drag to retime, double-click to delete)`;
    diamond.addEventListener('dblclick', () => {
      checkpoint();
      deleteKeyframe(track, key);
      notify();
      renderPose();
    });
    diamond.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      let pendingCheckpoint = true; // defer until real movement, not a plain click
      try { diamond.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
      const move = (e: PointerEvent) => {
        if (pendingCheckpoint) {
          checkpoint();
          pendingCheckpoint = false;
        }
        const rect = strip.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        key.time = Math.round((frac * duration) / 10) * 10;
        diamond.style.left = `${frac * 100}%`;
      };
      const up = () => {
        diamond.removeEventListener('pointermove', move);
        diamond.removeEventListener('pointerup', up);
        track.keyframes.sort((a, b) => a.time - b.time);
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

function startPlayback(): void {
  cancelAnimationFrame(rafId);
  lastTick = performance.now();
  const step = (now: number) => {
    if (!state.playing) return;
    const clip = activeClip();
    if (!clip) return;
    state.currentTime = (state.currentTime + (now - lastTick)) % clip.duration;
    lastTick = now;
    renderPose();
    const playhead = container.querySelector<HTMLElement>('.tl-playhead');
    if (playhead) playhead.style.left = `${(state.currentTime / clip.duration) * 100}%`;
    const timeLabel = container.querySelector<HTMLElement>('.tl-time');
    if (timeLabel) timeLabel.textContent = `${Math.round(state.currentTime)} ms`;
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
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
