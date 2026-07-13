/**
 * Timeline transport bar: playback (play/pause/step/jump + speed + fps/time
 * readouts), clip management (select/create/duplicate/rename/delete/duration/loop),
 * the keys/curves/logic mode picker, and the ping-pong/onion playback toggles.
 */

import { state, notify, activeClip, RigDoc, Clip } from '../core/model';
import { renderPose } from '../view';
import { checkpoint } from '../core/history';
import { stopPreview } from '../panels/smPanel';
import { dialog } from '../ui/dialogs';
import { tlCtx, PanelMode, div, button, movePlayheadTo, formatTime, toggleTimeDisplay } from './tlState';

/** Space-bar hook (from main.ts). */
export function togglePlay(): void {
  if (!activeClip() || state.editorMode !== 'animate') return;
  state.playing = !state.playing;
  if (state.playing) startPlayback();
  tlCtx.rerender();
}

export function startPlayback(): void {
  cancelAnimationFrame(tlCtx.rafId);
  tlCtx.lastTick = performance.now();
  tlCtx.fpsFrames = 0;
  tlCtx.fpsWindowStart = tlCtx.lastTick;
  const step = (now: number) => {
    if (!state.playing) return;
    const clip = activeClip();
    if (!clip) return;

    const advance = (now - tlCtx.lastTick) * state.playbackSpeed;
    tlCtx.lastTick = now;
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

    tlCtx.fpsFrames += 1;
    if (now - tlCtx.fpsWindowStart >= 500) {
      tlCtx.fpsValue = Math.round((tlCtx.fpsFrames * 1000) / (now - tlCtx.fpsWindowStart));
      tlCtx.fpsFrames = 0;
      tlCtx.fpsWindowStart = now;
      const fpsEl = tlCtx.container.querySelector<HTMLElement>('.tl-fps');
      if (fpsEl) fpsEl.textContent = `${tlCtx.fpsValue} fps`;
    }

    renderPose();
    const playhead = tlCtx.container.querySelector<HTMLElement>('.tl-playhead');
    if (playhead) playhead.style.left = `${(state.currentTime / clip.duration) * 100}%`;
    const timeLabel = tlCtx.container.querySelector<HTMLElement>('.tl-time');
    if (timeLabel) timeLabel.textContent = formatTime(state.currentTime);
    tlCtx.rafId = requestAnimationFrame(step);
  };
  tlCtx.rafId = requestAnimationFrame(step);
}

function setMode(next: PanelMode): void {
  if (tlCtx.panelMode === next) return;
  if (tlCtx.panelMode === 'logic') stopPreview();
  tlCtx.panelMode = next;
  tlCtx.rerender();
}

/** The full transport row: transport | clip management | modes | toggles clusters. */
export function buildTransportBar(doc: RigDoc, clip: Clip | null): HTMLElement {
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
  fpsEl.textContent = state.playing && tlCtx.fpsValue > 0 ? `${tlCtx.fpsValue} fps` : '';
  transportCluster.appendChild(fpsEl);

  const timeLabel = div('tl-time');
  timeLabel.textContent = formatTime(state.currentTime);
  timeLabel.title = 'Click to toggle ms / frames';
  timeLabel.onclick = () => { toggleTimeDisplay(); tlCtx.rerender(); };
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
    tlCtx.selectedKeys.clear();
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
    b.setAttribute('aria-checked', String(tlCtx.panelMode === m.key));
    if (tlCtx.panelMode === m.key) b.classList.add('active');
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
    tlCtx.rerender();
  });
  if (state.pingPong) pingPongBtn.classList.add('active');
  pingPongBtn.title = 'Bounce playback back and forth instead of looping';
  togglesCluster.appendChild(pingPongBtn);

  const onionBtn = button('🧅 onion', () => {
    state.onionSkin = !state.onionSkin;
    tlCtx.rerender();
    renderPose();
  });
  if (state.onionSkin) onionBtn.classList.add('active');
  onionBtn.title = 'Ghost the previous (red) and next (blue) keyed poses';
  togglesCluster.appendChild(onionBtn);

  bar.appendChild(togglesCluster);

  return bar;
}
