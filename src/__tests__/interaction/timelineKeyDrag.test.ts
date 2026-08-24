/**
 * Timeline key diamonds use an armed -> active gesture instead of treating the first
 * pointermove as a retime. These are real Chromium PointerEvents against the rendered
 * lane DOM: press wobble, pointer capture cancellation, history, and pixel thresholds
 * cannot be covered by the older helpers that jumped directly from down to a long drag.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canRedo, canUndo, redo, resetHistory, undo } from '../../core/history';
import { setKeyframeAt } from '../../core/model';
import { KEY_DRAG_AFTER_HOLD_PX, KEY_DRAG_HOLD_MS } from '../../timeline/lanes';
import {
  bootRig, clipTrack, notify, partByLabel, resetRig, setEditorMode, state,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

type Point = { x: number; y: number };
type PointerOptions = {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  pointerType?: 'mouse' | 'pen' | 'touch';
};

function fire(
  el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  point: Point, options: PointerOptions = {},
): void {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerId: 41,
    pointerType: options.pointerType ?? 'mouse',
    isPrimary: true,
    shiftKey: !!options.shiftKey,
    altKey: !!options.altKey,
    ctrlKey: !!options.ctrlKey,
  }));
}

function center(el: HTMLElement): Point {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function offset(point: Point, dx: number, dy = 0): Point {
  return { x: point.x + dx, y: point.y + dy };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function lane(partLabel: string, channel: string): HTMLElement {
  const label = [...document.querySelectorAll<HTMLElement>('.tl-lane-label')]
    .find((candidate) => candidate.textContent === `${partLabel}.${channel}`);
  if (!label) throw new Error(`Missing ${partLabel}.${channel} lane`);
  return label.closest<HTMLElement>('.tl-lane')!;
}

function diamond(partLabel: string, channel: string, index = 0): HTMLElement {
  const result = lane(partLabel, channel).querySelectorAll<HTMLElement>('.tl-key')[index];
  if (!result) throw new Error(`Missing key ${index} on ${partLabel}.${channel}`);
  return result;
}

function setUpKeys(): { id: string; rotateValue: number } {
  setEditorMode('animate');
  const id = partByLabel('right_arm').id;
  setKeyframeAt(id, 'rotate', 300, 17);
  notify();
  resetHistory();
  state.dirty = false;
  return { id, rotateValue: 17 };
}

function keyTime(id: string, channel = 'rotate', index = 0): number {
  return clipTrack(id, channel as 'rotate')!.keyframes[index].time;
}

function clickWithJitter(el: HTMLElement, dx: number, options: PointerOptions = {}): void {
  const from = center(el);
  fire(el, 'pointerdown', from, options);
  if (dx !== 0) fire(el, 'pointermove', offset(from, dx), options);
  fire(el, 'pointerup', offset(from, dx), options);
}

describe('timeline key gesture activation', () => {
  it('an exact click and rapid repeated 1-5px press wobbles select without editing or history', () => {
    const { id, rotateValue } = setUpKeys();
    for (const dx of [0, 1, -2, 3, -4, 5, 0, -1]) {
      clickWithJitter(diamond('right_arm', 'rotate'), dx);
      expect(keyTime(id), `time after ${dx}px wobble`).toBe(300);
      expect(clipTrack(id, 'rotate')!.keyframes[0].value).toBe(rotateValue);
      expect(canUndo(), `history after ${dx}px wobble`).toBe(false);
      expect(document.querySelectorAll('.tl-key.selected')).toHaveLength(1);
    }
  });

  it('a slow movement that stays below the 6px threshold and a hold without movement remain clicks', async () => {
    const { id } = setUpKeys();
    let el = diamond('right_arm', 'rotate');
    let from = center(el);
    fire(el, 'pointerdown', from, { pointerType: 'pen' });
    for (let dx = 1; dx <= 5; dx++) {
      await wait(45);
      fire(el, 'pointermove', offset(from, dx), { pointerType: 'pen' });
    }
    fire(el, 'pointerup', offset(from, 5), { pointerType: 'pen' });
    expect(keyTime(id)).toBe(300);
    expect(canUndo()).toBe(false);

    el = diamond('right_arm', 'rotate');
    from = center(el);
    fire(el, 'pointerdown', from, { pointerType: 'touch' });
    await wait(KEY_DRAG_HOLD_MS + 40);
    expect(el.classList.contains('armed')).toBe(true);
    expect(el.classList.contains('dragging')).toBe(false);
    fire(el, 'pointerup', from, { pointerType: 'touch' });
    expect(keyTime(id)).toBe(300);
    expect(canUndo()).toBe(false);
  });

  it('a quick decisive drag activates immediately, preserves value, and is one undo/redo step', () => {
    const { id, rotateValue } = setUpKeys();
    const el = diamond('right_arm', 'rotate');
    const from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 36));
    expect(el.classList.contains('dragging')).toBe(true);
    fire(el, 'pointerup', offset(from, 36));

    const movedTime = keyTime(id);
    expect(movedTime).toBeGreaterThan(300);
    expect(movedTime % 10).toBe(0);
    expect(clipTrack(id, 'rotate')!.keyframes[0].value).toBe(rotateValue);
    expect(canUndo()).toBe(true);
    undo();
    expect(keyTime(id)).toBe(300);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
    redo();
    expect(keyTime(id)).toBe(movedTime);
  });

  it('a held subtle drag activates at 6px while 5px remains inert, independent of strip width', async () => {
    const { id } = setUpKeys();
    const strip = lane('right_arm', 'rotate').querySelector<HTMLElement>('.tl-strip')!;
    strip.style.flex = '0 0 260px';
    strip.style.width = '260px';
    const el = diamond('right_arm', 'rotate');
    const from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, KEY_DRAG_AFTER_HOLD_PX));
    expect(el.classList.contains('dragging')).toBe(false);
    await wait(KEY_DRAG_HOLD_MS + 30);
    expect(el.classList.contains('dragging')).toBe(true);
    fire(el, 'pointerup', offset(from, KEY_DRAG_AFTER_HOLD_PX));
    expect(keyTime(id)).toBeGreaterThan(300);
    expect(canUndo()).toBe(true);
  });

  it('Shift selection retimes multiple keys by the same snapped delta', () => {
    const { id } = setUpKeys();
    setKeyframeAt(id, 'tx', 500, 42);
    notify();
    resetHistory();

    clickWithJitter(diamond('right_arm', 'rotate'), 0);
    clickWithJitter(diamond('right_arm', 'tx'), 0, { shiftKey: true });
    expect(document.querySelectorAll('.tl-key.selected')).toHaveLength(2);

    const el = diamond('right_arm', 'tx');
    const from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 42), { altKey: true });
    fire(el, 'pointerup', offset(from, 42), { altKey: true });
    const rotateTime = keyTime(id, 'rotate');
    const txTime = keyTime(id, 'tx');
    expect(rotateTime - 300).toBe(txTime - 500);
    expect(rotateTime - 300).toBeGreaterThan(0);
    expect(clipTrack(id, 'tx')!.keyframes[0].value).toBe(42);
    expect(canUndo()).toBe(true);
  });

  it('Escape and pointercancel restore times, selection, playhead, dirty state, and history', () => {
    const { id } = setUpKeys();
    state.currentTime = 120;
    let el = diamond('right_arm', 'rotate');
    let from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 40));
    expect(keyTime(id)).not.toBe(300);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
    expect(keyTime(id)).toBe(300);
    expect(state.currentTime).toBe(120);
    expect(state.dirty).toBe(false);
    expect(canUndo()).toBe(false);

    el = diamond('right_arm', 'rotate');
    from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 40));
    fire(el, 'pointercancel', offset(from, 40));
    expect(keyTime(id)).toBe(300);
    expect(state.dirty).toBe(false);
    expect(canUndo()).toBe(false);
  });

  it('clamps deliberate endpoint drags and a drag returned to its origin is history-neutral', () => {
    const { id } = setUpKeys();
    let el = diamond('right_arm', 'rotate');
    let from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 40));
    fire(el, 'pointermove', from);
    fire(el, 'pointerup', from);
    expect(keyTime(id)).toBe(300);
    expect(canUndo()).toBe(false);

    el = diamond('right_arm', 'rotate');
    from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, -2000));
    fire(el, 'pointerup', offset(from, -2000));
    expect(keyTime(id)).toBe(0);
    undo();
    expect(keyTime(id)).toBe(300);

    el = diamond('right_arm', 'rotate');
    from = center(el);
    fire(el, 'pointerdown', from);
    fire(el, 'pointermove', offset(from, 2000));
    fire(el, 'pointerup', offset(from, 2000));
    expect(keyTime(id)).toBe(state.doc!.clips[state.activeClipIndex].duration);
  });
});
