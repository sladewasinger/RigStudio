/**
 * Editing ergonomics wave (ROADMAP.md "Editing ergonomics wave", user report: "extremely
 * hard to see what I'm editing" with unnamed bones) — clicking a keyframe in the Animate
 * timeline selects the track's TARGET part (layers highlights it + auto-expands ancestors
 * via the existing selection machinery, inspector shows a section for it). Multi-key/
 * marquee selection selects the UNION of target parts. The synthetic `root` target
 * contributes no part selection. A retime drag must not churn part selection every
 * pointermove — only once, at the initial press (`timeline/tlState.ts`'s
 * `syncPartSelectionFromKeys`, called from `timeline/lanes.ts`).
 *
 * Diamonds live OUTSIDE the canvas svg's DOM subtree, so the harness's `click()` (which
 * always routes its pointerup through `svgEl()` — correct for CANVAS gestures, whose
 * capture target is the svg) can't reach a diamond's own pointerup listener: real pointer
 * capture retargeting only kicks in for events actually dispatched on/through the
 * capturing element's subtree. Diamond clicks here use `dragOnElement(diamond, pt, pt, 0)`
 * instead — zero intermediate moves, every event dispatched directly on the diamond,
 * exactly the harness's documented pattern for "timeline diamonds or the splitter".
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setKeyframe, selectPart as modelSelectPart } from '../../core/model';
import {
  bootRig, resetRig, state, notify, setEditorMode, partByLabel, clientPointOnPart,
  gestureDrag, dragOnElement, clipTrack,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function laneLabelEl(partLabel: string, channel: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('#timeline .tl-lane-label'));
  const found = labels.find((l) => l.textContent === `${partLabel}.${channel}`);
  if (!found) throw new Error(`no lane for "${partLabel}.${channel}"`);
  return found;
}

/** The first (only, in these fixtures) diamond in a track's lane. */
function diamondFor(partLabel: string, channel: string): HTMLElement {
  const lane = laneLabelEl(partLabel, channel).closest('.tl-lane') as HTMLElement;
  const diamond = lane.querySelector<HTMLElement>('.tl-key');
  if (!diamond) throw new Error(`no key diamond in lane "${partLabel}.${channel}"`);
  return diamond;
}

function diamondCenter(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A true click (down, zero moves, up) dispatched entirely on the diamond itself. */
function clickDiamond(el: HTMLElement): void {
  const c = diamondCenter(el);
  dragOnElement(el, c, c, 0);
}

function inspectorHeadings(): string[] {
  return Array.from(document.querySelectorAll('#inspector h3')).map((h) => h.textContent ?? '');
}

describe('scenario — clicking a keyframe selects its target part', () => {
  it('selects the part, and the inspector grows a section headed with its label', () => {
    setEditorMode('animate');
    const part = partByLabel('right_arm');
    const pt = clientPointOnPart('right_arm');
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 20 }); // first-click gizmo drag keys tx/ty
    expect(clipTrack(part.id, 'tx'), 'tx track keyed').toBeTruthy();

    // Deselect first so the click below is what causes selection, not a drag leftover.
    modelSelectPart(null);
    notify();
    expect(state.selectedPartId, 'sanity: nothing selected before the click').toBeNull();

    clickDiamond(diamondFor('right_arm', 'tx'));

    expect(state.selectedPartId, 'clicking the key selects its target part').toBe(part.id);
    expect(state.selectedPartIds).toEqual([part.id]);
    expect(
      inspectorHeadings().some((h) => h.startsWith('right_arm')),
      'inspector shows a section headed with the part\'s label',
    ).toBe(true);
  });
});

describe('scenario — marquee across keys from two different tracks selects both target parts', () => {
  it('state.selectedPartIds becomes the union of both tracks\' targets', () => {
    setEditorMode('animate');
    // Off the t=0 edge (see timeline.test.ts's marquee scenario) so the diamonds sit
    // inside the strip, not flush against its left edge where the marquee start below
    // (padRect.left + 30) would miss them entirely.
    state.currentTime = 300;
    const rightArm = partByLabel('right_arm');
    const leftArm = partByLabel('left_arm');
    const ptR = clientPointOnPart('right_arm');
    gestureDrag(ptR, { x: ptR.x + 35, y: ptR.y - 20 });
    const ptL = clientPointOnPart('left_arm');
    gestureDrag(ptL, { x: ptL.x - 35, y: ptL.y - 20 });
    expect(clipTrack(rightArm.id, 'tx'), 'right_arm tx keyed').toBeTruthy();
    expect(clipTrack(leftArm.id, 'tx'), 'left_arm tx keyed').toBeTruthy();

    const padTop = document.querySelectorAll<HTMLElement>('#timeline .tl-lanes-pad')[0];
    const laneEls = document.querySelectorAll<HTMLElement>('#timeline .tl-lane');
    expect(laneEls.length, 'four lanes present (tx+ty for each arm)').toBeGreaterThanOrEqual(4);
    const padRect = padTop.getBoundingClientRect();
    const lastRect = laneEls[laneEls.length - 1].getBoundingClientRect();

    dragOnElement(
      padTop,
      { x: padRect.left + 30, y: padRect.top + padRect.height / 2 },
      { x: lastRect.right - 10, y: lastRect.bottom - 4 },
    );

    expect(document.querySelectorAll('#timeline .tl-key.selected').length, 'all 4 keys touched').toBe(4);
    expect(
      new Set(state.selectedPartIds),
      'both arms selected, nothing else',
    ).toEqual(new Set([rightArm.id, leftArm.id]));
  });
});

describe('scenario — a root-targeted keyframe click leaves part selection unchanged', () => {
  it('root is a synthetic whole-figure target, never a real part', () => {
    setEditorMode('animate');
    setKeyframe('root', 'ty', 0); // legacy root track (A0 demoted root from the UI; model still supports it)
    notify(); // rebuild the timeline so the new lane/diamond exist

    const arm = partByLabel('right_arm');
    modelSelectPart(arm.id);
    notify();
    expect(state.selectedPartId).toBe(arm.id);

    clickDiamond(diamondFor('root', 'ty'));

    expect(state.selectedPartId, 'root-track key click leaves the existing selection untouched').toBe(arm.id);
    expect(state.selectedPartIds).toEqual([arm.id]);
  });
});

describe('scenario — a full retime drag changes part selection exactly once', () => {
  it('no per-pointermove selection churn — one assignment for the whole gesture', () => {
    setEditorMode('animate');
    const part = partByLabel('right_arm');
    const pt = clientPointOnPart('right_arm');
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 20 });
    notify();

    const diamond = diamondFor('right_arm', 'tx');

    let backing = state.selectedPartIds;
    let assignCount = 0;
    Object.defineProperty(state, 'selectedPartIds', {
      configurable: true,
      get() { return backing; },
      set(v: string[]) { backing = v; assignCount++; },
    });
    try {
      const from = diamondCenter(diamond);
      const to = { x: from.x + 40, y: from.y }; // retime rightward along the strip
      dragOnElement(diamond, from, to, 8); // 8 intermediate pointermoves + down/up
    } finally {
      Object.defineProperty(state, 'selectedPartIds', {
        configurable: true, writable: true, enumerable: true, value: backing,
      });
    }

    expect(assignCount, 'selectedPartIds assigned exactly once for the whole drag').toBe(1);
    expect(state.selectedPartId).toBe(part.id);
  });
});
