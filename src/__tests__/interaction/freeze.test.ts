/**
 * Interaction tests for FREEZE (origin-editing) mode (v2.13). Off by default, pivots /
 * origins / shared joints are VISIBLE but inert: a stray press is a byte-level no-op
 * (the user's constant-accidental-origin-drag complaint). Y (or the canvas-tools button)
 * enters freeze — an unmissable banner + tint appear and the same drags now edit the
 * joint; Escape exits.
 *
 * Mutation-check note: removing the `if (!state.freezeMode) return` gate in
 * interactions.ts's pivot / joint-tip branches makes the "no-op outside freeze"
 * assertions below fail (the drag moves the joint with freeze off), so these scenarios
 * genuinely pin the gate rather than passing vacuously.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { selectPart as modelSelectPart } from '../../core/model';
import { startBonePlacement, renderPose } from '../../view';
import {
  bootRig, resetRig, state, notify, partByLabel, gestureDrag, docToClient,
  clientCenterOf, overlayEl, expectClose, selectByLabel, repaint, pressKey,
  medialPoints,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Place an n-bone chain down a limb's medial axis (mirrors bones.test.ts's helper). */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  const pts = medialPoints(label, n);
  modelSelectPart(null);
  notify();
  renderPose();
  const bones: ReturnType<typeof partByLabel>[] = [];
  for (let k = 1; k <= n; k++) {
    const press = k === 1 ? pts[0] : { x: pts[k - 1].x + 28, y: pts[k - 1].y + 18 };
    startBonePlacement();
    gestureDrag(press, pts[k]);
    bones.push(state.doc!.parts[state.doc!.parts.length - 1]);
  }
  return bones;
}

describe('scenario F1 — an art-part pivot is inert outside freeze, editable inside', () => {
  it('a pivot-handle drag is a byte-level no-op with freeze off, and moves the joint with freeze on', () => {
    // Give the part a non-trivial rest so the pivot-compensation solve has real work
    // to do inside freeze (mirrors the rig-drags pivot scenario).
    const p0 = partByLabel('right_arm');
    p0.rest.rotate = 20;
    p0.rest.sx = 1.2;
    selectByLabel('right_arm');
    repaint();

    const pivotBefore = { ...partByLabel('right_arm').pivot };
    const txBefore = partByLabel('right_arm').rest.tx;
    const tyBefore = partByLabel('right_arm').rest.ty;

    // Freeze OFF (default): press-drag the pivot handle → NOTHING changes.
    let pivotC = docToClient(partByLabel('right_arm').pivot);
    gestureDrag(pivotC, { x: pivotC.x + 32, y: pivotC.y - 22 });
    expect(partByLabel('right_arm').pivot).toEqual(pivotBefore);
    expect(partByLabel('right_arm').rest.tx).toBe(txBefore);
    expect(partByLabel('right_arm').rest.ty).toBe(tyBefore);

    // Freeze ON (Y): the very same drag now re-anchors the joint.
    pressKey('y');
    repaint();
    pivotC = docToClient(partByLabel('right_arm').pivot);
    gestureDrag(pivotC, { x: pivotC.x + 32, y: pivotC.y - 22 });
    const after = partByLabel('right_arm');
    const moved = Math.hypot(after.pivot.x - pivotBefore.x, after.pivot.y - pivotBefore.y)
      + Math.hypot(after.rest.tx - txBefore, after.rest.ty - tyBefore);
    expect(moved, 'pivot / rest changed inside freeze').toBeGreaterThan(0.5);
  });
});

describe('scenario F2 — a chain joint (child bone origin) is inert outside freeze', () => {
  it('dragging the shared joint is a no-op with freeze off; inside freeze it moves and the parent tip follows', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    state.tool = 'select';
    modelSelectPart(b2.id); // select the CHILD; its origin is the shared joint
    notify();
    repaint();

    const pivot0 = { ...cur(b2.id).pivot };
    const tip0 = { ...cur(b1.id).boneTip! };

    // Freeze OFF: dragging the child pivot handle changes nothing.
    let from = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    gestureDrag(from, { x: from.x + 26, y: from.y + 20 });
    expect(cur(b2.id).pivot).toEqual(pivot0);
    expect(cur(b1.id).boneTip).toEqual(tip0);

    // Freeze ON: the joint drags AND the parent tip tracks it (shared-joint coupling).
    pressKey('y');
    repaint();
    from = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    gestureDrag(from, { x: from.x + 26, y: from.y + 20 });
    const moved = Math.hypot(cur(b2.id).pivot.x - pivot0.x, cur(b2.id).pivot.y - pivot0.y);
    expect(moved, 'joint moved inside freeze').toBeGreaterThan(0.3);
    expectClose(cur(b1.id).boneTip!.x, cur(b2.id).pivot.x, 0.3, 'parent tip followed the joint');
    expectClose(cur(b1.id).boneTip!.y, cur(b2.id).pivot.y, 0.3, 'parent tip followed the joint');
  });
});

describe('scenario F3 — the freeze indicator + Y / Escape toggling', () => {
  it('Y turns on the banner/tint (freeze-mode class + visible banner); Escape exits', () => {
    const canvas = document.getElementById('canvas')!;
    const banner = document.querySelector('.freeze-banner') as HTMLElement;
    expect(banner, 'freeze banner always present in the DOM').toBeTruthy();

    // Off by default: class absent, banner hidden.
    expect(canvas.classList.contains('freeze-mode')).toBe(false);
    expect(getComputedStyle(banner).display).toBe('none');

    pressKey('y');
    expect(state.freezeMode).toBe(true);
    expect(canvas.classList.contains('freeze-mode'), 'freeze-mode class drives banner + tint').toBe(true);
    expect(getComputedStyle(banner).display).not.toBe('none');

    // Escape is an early tier — it exits freeze before any other Escape handling.
    pressKey('Escape');
    expect(state.freezeMode).toBe(false);
    expect(canvas.classList.contains('freeze-mode')).toBe(false);
    expect(getComputedStyle(banner).display).toBe('none');
  });
});
