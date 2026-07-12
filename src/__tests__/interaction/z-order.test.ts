/**
 * Interaction tests for keyframeable z-order (editor side).
 *
 * The keyable per-part `z` OFFSET restacks the canvas over time: renderPose sorts the part
 * groups by (effective z ascending, doc.parts index ascending) each frame and re-appends
 * them, so a keyed z flips paint order at the key (STEPPED — no blend between ranks). These
 * scenarios pin: (1) the DOM part-group order flips EXACTLY at the key when scrubbing (the
 * per-frame path playback drives), (2) one undo removes the z key and restores the authored
 * order, (3) the Edit-mode ▲/▼ stacking buttons move a part in doc.parts identically to
 * PageUp. Mutation guard: sabotaging applyDrawOrder (skip the re-append) fails scenarios 1–2;
 * sabotaging stepped sampling (interpolate z) breaks the "exactly at the key" assertions.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkpoint, undo } from '../../core/history';
import { setKeyframeAt, notify, selectPart as modelSelectPart } from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, repaint, rootGEl,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** The live DOM paint order of the part groups (rootGroup's only children). */
function domPartOrder(): string[] {
  return Array.from(rootGEl().children)
    .map((c) => (c as SVGElement).dataset?.partId)
    .filter((id): id is string => !!id);
}

function domIndexOf(id: string): number {
  return domPartOrder().indexOf(id);
}

/** Scrub to a time and render exactly as a playback frame would. */
function scrubTo(ms: number): void {
  state.currentTime = ms;
  repaint();
}

describe('scenario — a keyed z flips DOM paint order exactly at the key', () => {
  it('a behind-part keyed z-forward at t=500 draws behind before the key and in front at/after it', () => {
    setEditorMode('animate');
    // parts[0] is painted first (bottom-most), parts[1] above it — so parts[0] starts BEHIND.
    const behind = state.doc!.parts[0];
    const front = state.doc!.parts[1];

    scrubTo(0);
    expect(domIndexOf(behind.id)).toBeLessThan(
      domIndexOf(front.id),
    ); // authored order: `behind` under `front`

    // Key z = 5 on the behind-part at t=500 (a single stepped key). Under one checkpoint so
    // scenario 2's undo can revert it.
    checkpoint();
    setKeyframeAt(behind.id, 'z', 500, 5);
    notify();

    // Stepped: before the key the offset is still 0 (authored order holds)…
    scrubTo(499);
    expect(domIndexOf(behind.id)).toBeLessThan(domIndexOf(front.id));

    // …and exactly at the key it jumps to z=5 → sorts after every z=0 part (drawn last/top).
    scrubTo(500);
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id));
    expect(domIndexOf(behind.id)).toBe(domPartOrder().length - 1); // lifted fully to the front

    // Held after the last key (playback across the key keeps the restacked order every frame).
    scrubTo(1200);
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id));
  });
});

describe('scenario — one undo removes the z key and restores authored order', () => {
  it('undo reverts the restack (the part is behind again at the same time)', () => {
    setEditorMode('animate');
    const behindId = state.doc!.parts[0].id;
    const frontId = state.doc!.parts[1].id;

    checkpoint();
    setKeyframeAt(behindId, 'z', 500, 5);
    notify();
    scrubTo(500);
    expect(domIndexOf(behindId)).toBeGreaterThan(domIndexOf(frontId)); // restacked in front

    undo(); // restore-handler rebuilds the canvas; state.doc is swapped
    // currentTime is still 500, but the z track is gone → authored order restored.
    expect(state.doc!.clips[state.activeClipIndex].tracks.some((t) => t.channel === 'z')).toBe(false);
    expect(domIndexOf(behindId)).toBeLessThan(domIndexOf(frontId));
  });
});

describe('scenario — Edit-mode stacking ▲/▼ mirror PageUp/PageDown', () => {
  function stackingButtons(): { up: HTMLButtonElement; down: HTMLButtonElement } {
    const btns = document.querySelectorAll<HTMLButtonElement>('#inspector .stacking-step');
    if (btns.length < 2) throw new Error('stacking ▲/▼ buttons not found in the inspector');
    return { up: btns[0], down: btns[1] };
  }

  it('clicking ▲ moves the selected part forward in doc.parts (and the DOM) like PageUp', () => {
    setEditorMode('setup');
    const target = state.doc!.parts[0];
    const startIdx = state.doc!.parts.indexOf(target);
    modelSelectPart(target.id);
    notify(); // build the inspector with the stacking row

    stackingButtons().up.click(); // ▲ = bring forward (PageUp)

    const afterBtn = state.doc!.parts.indexOf(target);
    expect(afterBtn).toBe(startIdx + 1); // stepped one forward in the authored order
    // DOM paint order followed the model (reorderCanvas ran).
    expect(domIndexOf(target.id)).toBe(afterBtn);

    // PageUp on the same fresh selection produces the identical move.
    resetRig();
    setEditorMode('setup');
    const t2 = state.doc!.parts[0];
    modelSelectPart(t2.id);
    notify();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
    expect(state.doc!.parts.indexOf(t2)).toBe(startIdx + 1);
  });

  it('▼ is disabled for the bottom-most part (cannot send further back)', () => {
    setEditorMode('setup');
    const bottom = state.doc!.parts[0]; // index 0 = bottom of the draw order
    modelSelectPart(bottom.id);
    notify();
    expect(stackingButtons().down.disabled).toBe(true);
    expect(stackingButtons().up.disabled).toBe(false);
  });
});
