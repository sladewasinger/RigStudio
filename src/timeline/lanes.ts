/**
 * Keyframe lanes: the scrubber ruler and one lane per animated track, with
 * click/shift-click/marquee selection and retime drag on the diamonds.
 */

import { state, notify, deleteKeyframe, Track, Keyframe, Clip } from '../core/model';
import { renderPose } from '../view';
import { checkpoint } from '../core/history';
import { tlCtx, div, movePlayheadTo, syncPartSelectionFromKeys } from './tlState';

/** The whole lanes area: ruler + padding + one lane per track + padding, with marquee
 *  box-select wired across the block. */
export function buildLanesPanel(clip: Clip): HTMLElement {
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
    const timeEl = tlCtx.container.querySelector<HTMLElement>('.tl-time');
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
  return lanes;
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
    if (tlCtx.selectedKeys.has(key)) diamond.classList.add('selected');
    diamond.title =
      `${key.time} ms = ${key.value} · ${key.easing}\n` +
      'click: select · drag: retime · double-click: delete';
    tlCtx.diamondEls.push({ el: diamond, key });
    diamond.addEventListener('dblclick', () => {
      checkpoint();
      tlCtx.selectedKeys.delete(key);
      deleteKeyframe(track, key);
      notify();
      renderPose();
    });
    diamond.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      // Selection first: plain click selects this key; Shift toggles membership; a key
      // already in the selection keeps the group (so dragging moves them all).
      if (ev.shiftKey) {
        if (tlCtx.selectedKeys.has(key)) tlCtx.selectedKeys.delete(key);
        else tlCtx.selectedKeys.add(key);
      } else if (!tlCtx.selectedKeys.has(key)) {
        tlCtx.selectedKeys.clear();
        tlCtx.selectedKeys.add(key);
      }
      // Selects the target part(s) too — ONCE per press, not per retime-drag pointermove
      // (see tlState.ts's syncPartSelectionFromKeys); the deferred notify() in `up` below
      // is what actually repaints the layers tree/inspector for it.
      syncPartSelectionFromKeys();
      // Scrub to the clicked key so the canvas shows the pose it records.
      movePlayheadTo(key.time, duration);

      let pendingCheckpoint = true; // defer until real movement, not a plain click
      let moved = false;
      const startTimes = new Map<Keyframe, number>([...tlCtx.selectedKeys].map((k) => [k, k.time]));
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
        for (const d of tlCtx.diamondEls) {
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
            tlCtx.trackOfKey.get(k)?.keyframes.sort((a, b) => a.time - b.time);
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
      if (!e.shiftKey) tlCtx.selectedKeys.clear();
      for (const { el, key } of tlCtx.diamondEls) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) tlCtx.selectedKeys.add(key);
      }
      // Union of the marquee's touched keys' target parts (see tlState.ts's
      // syncPartSelectionFromKeys) — notify() repaints layers/inspector AND the
      // timeline itself (its subscriber calls the same render() tlCtx.rerender points at).
      syncPartSelectionFromKeys();
      notify();
    };
    lanes.addEventListener('pointermove', move);
    lanes.addEventListener('pointerup', up);
  });
}
