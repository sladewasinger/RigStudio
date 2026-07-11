/**
 * P5a timeline/Animate panel overhaul: the fixed-height shell + resize splitter, the
 * transport jump/step buttons, marquee-friendly lane padding, and the mode picker.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { TIMELINE_HEIGHT_KEY } from '../../timeline/timeline';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag,
  setEditorMode, clipTrack, dragOnElement, expectClose,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function tlBtn(action: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`#timeline [data-tl-action="${action}"]`);
  if (!el) throw new Error(`no timeline button for action "${action}"`);
  return el;
}

describe('scenario — resize splitter (P5a item 2)', () => {
  it('dragging the handle changes #timeline height and persists it to localStorage', () => {
    setEditorMode('animate');
    const timelineEl = document.getElementById('timeline')!;
    const splitter = document.getElementById('timeline-splitter')!;
    const before = timelineEl.getBoundingClientRect().height;

    const rect = splitter.getBoundingClientRect();
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const growBy = 40; // dragging UP grows the panel (it sits at the bottom of the layout)
    dragOnElement(splitter, from, { x: from.x, y: from.y - growBy });

    const after = timelineEl.getBoundingClientRect().height;
    expectClose(after - before, growBy, 1, 'splitter drag grows the panel by the drag distance');

    const stored = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
    expectClose(stored, after, 1, 'height persisted to localStorage on release');
  });
});

describe('scenario — transport buttons (P5a item 3)', () => {
  it('jump/step buttons move state.currentTime exactly, matching the arrow-key step', () => {
    setEditorMode('animate');
    const duration = state.doc!.clips[state.activeClipIndex].duration;

    state.currentTime = 500;
    tlBtn('step-back').click();
    expect(state.currentTime).toBe(490);

    tlBtn('step-fwd').click();
    tlBtn('step-fwd').click();
    expect(state.currentTime).toBe(510);

    tlBtn('jump-end').click();
    expect(state.currentTime).toBe(duration);
    // Step forward past the end clamps at duration, doesn't overshoot.
    tlBtn('step-fwd').click();
    expect(state.currentTime).toBe(duration);

    tlBtn('jump-start').click();
    expect(state.currentTime).toBe(0);
    // Step back past 0 clamps at 0.
    tlBtn('step-back').click();
    expect(state.currentTime).toBe(0);
  });
});

describe('scenario — marquee starts in the lane padding (P5a item 4)', () => {
  it('a drag started in the padding above the lane block still box-selects diamonds', () => {
    setEditorMode('animate');
    // Off the t=0 edge so the diamonds sit inside the strip, not flush against it —
    // keeps the marquee coordinates below robust to exact pixel alignment.
    state.currentTime = 300;
    const id = partByLabel('right_arm').id;
    const pt = clientPointOnPart('right_arm');
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 20 }); // first-click gizmo drag keys tx/ty
    expect(clipTrack(id, 'tx'), 'tx track keyed').toBeTruthy();
    expect(clipTrack(id, 'ty'), 'ty track keyed').toBeTruthy();

    const padTop = document.querySelectorAll<HTMLElement>('#timeline .tl-lanes-pad')[0];
    expect(padTop, 'padding row above the lane block exists').toBeTruthy();
    const laneEls = document.querySelectorAll<HTMLElement>('#timeline .tl-lane');
    expect(laneEls.length, 'tx + ty lanes present').toBeGreaterThanOrEqual(2);

    const padRect = padTop.getBoundingClientRect();
    const lastRect = laneEls[laneEls.length - 1].getBoundingClientRect();
    // Starts inside the padding (above the first strip, below the ruler — never
    // touching the scrubber) and ends past the last lane.
    dragOnElement(
      padTop,
      { x: padRect.left + 30, y: padRect.top + padRect.height / 2 },
      { x: lastRect.right - 10, y: lastRect.bottom - 4 },
    );

    expect(document.querySelectorAll('#timeline .tl-key.selected').length).toBe(2);
  });
});

describe('scenario — mode picker is mutually exclusive (P5a item 5)', () => {
  it('logic replaces the lanes area; curves adds beneath it; only one mode is active', () => {
    setEditorMode('animate');
    expect(document.querySelector('#timeline .tl-lanes')).toBeTruthy();
    expect(document.querySelector('#timeline .graph-panel')).toBeFalsy();

    // Curves is additive (a plot beneath the lanes, matching the pre-P5a "curves"
    // toggle) — mutual exclusivity is with LOGIC, which replaces the lanes area.
    tlBtn('mode-curves').click();
    expect(document.querySelector('#timeline .tl-lanes')).toBeTruthy();
    expect(document.querySelector('#timeline .graph-panel')).toBeTruthy();
    expect(document.querySelector('#timeline .sm-panel-host')).toBeFalsy();

    tlBtn('mode-logic').click();
    expect(document.querySelector('#timeline .graph-panel')).toBeFalsy();
    expect(document.querySelector('#timeline .tl-lanes')).toBeFalsy();
    expect(document.querySelector('#timeline .sm-panel-host')).toBeTruthy();

    tlBtn('mode-keys').click();
    expect(document.querySelector('#timeline .sm-panel-host')).toBeFalsy();
    expect(document.querySelector('#timeline .tl-lanes')).toBeTruthy();
  });
});
