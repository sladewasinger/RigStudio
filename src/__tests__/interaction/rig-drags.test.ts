import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { applyMat } from '../../geometry/transforms';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag,
  screenScale, expectClose, docToClient, selectByLabel, overlayEl, overlayCount,
  clientCenterOf, partMatrix, partGroupEl, setEditorMode, clipTrack, repaint, click,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

describe('boot', () => {
  it("seeds right_arm's pivot from the composed rotation matrix", () => {
    const p = partByLabel('right_arm').pivot;
    expectClose(p.x, 66.641, 0.01, 'right_arm pivot.x');
    expectClose(p.y, 119.592, 0.01, 'right_arm pivot.y');
  });
});

describe('scenario 1 — setup drag-move', () => {
  it('writes rest tx/ty, creates no tracks, and reverts in one undo', () => {
    const part = partByLabel('left_leg');
    const tx0 = part.rest.tx, ty0 = part.rest.ty;
    expect(state.doc!.clips[0].tracks.length).toBe(0);

    const from = clientPointOnPart('left_leg');
    const scale = screenScale();
    const dClient = { x: 40, y: 25 };
    gestureDrag(from, { x: from.x + dClient.x, y: from.y + dClient.y });

    // No parent → chain identity in Setup, so the rest delta equals the client delta
    // divided by the on-screen scale (root == user space).
    const after = partByLabel('left_leg');
    expectClose(after.rest.tx - tx0, dClient.x / scale, 0.2, 'rest.tx delta');
    expectClose(after.rest.ty - ty0, dClient.y / scale, 0.2, 'rest.ty delta');
    expect(state.doc!.clips[0].tracks.length).toBe(0);

    expect(canUndo()).toBe(true);
    undo();
    const reverted = partByLabel('left_leg'); // re-read: undo swaps the doc object
    expectClose(reverted.rest.tx, tx0, 1e-9, 'rest.tx restored');
    expectClose(reverted.rest.ty, ty0, 1e-9, 'rest.ty restored');
  });
});

describe('scenario 2 — SE scale handle', () => {
  it('scales ~20% about the pinned NW anchor, pivot unchanged', () => {
    selectByLabel('right_arm');
    expect(overlayCount('.scale-handle')).toBe(8);
    const pivot0 = { ...partByLabel('right_arm').pivot };

    const se = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const nw = clientCenterOf(overlayEl().querySelector('[data-handle="nw"]')!);
    // Push SE outward by 20% of the SE↔NW diagonal → uniform factor 1.2 about NW.
    const target = { x: se.x + 0.2 * (se.x - nw.x), y: se.y + 0.2 * (se.y - nw.y) };
    gestureDrag(se, target);

    const part = partByLabel('right_arm');
    expectClose(part.rest.sx, 1.2, 0.05, 'rest.sx');
    expectClose(part.rest.sy, 1.2, 0.05, 'rest.sy');

    const nwAfter = clientCenterOf(overlayEl().querySelector('[data-handle="nw"]')!);
    expectClose(Math.hypot(nwAfter.x - nw.x, nwAfter.y - nw.y), 0, 0.5, 'anchor drift');
    expectClose(part.pivot.x, pivot0.x, 1e-9, 'pivot.x unchanged');
    expectClose(part.pivot.y, pivot0.y, 1e-9, 'pivot.y unchanged');
  });
});

describe('scenario 3 — handle-set toggle + rotate handle', () => {
  it('toggles to the rotate/skew set and a rotate drag sets rest.rotate', () => {
    selectByLabel('right_arm');
    expect(overlayCount('.scale-handle')).toBe(8);

    // A motionless click on the already-primary part swaps handle sets. Compute the
    // press point AFTER selecting so it's verified clear of the overlay handles.
    const body = clientPointOnPart('right_arm');
    click(body.x, body.y);
    expect(overlayCount('.rotate-handle')).toBe(4);
    expect(overlayCount('.skew-handle')).toBe(4);

    const part = partByLabel('right_arm');
    const rot0 = part.rest.rotate;
    const pivotC = docToClient(part.pivot); // effectivePivot == pivot in Setup
    // Pick the rotate handle farthest from the pivot for a clean lever arm.
    const handles = Array.from(overlayEl().querySelectorAll('[data-role="rotate-handle"]'));
    const withDist = handles.map((h) => {
      const c = clientCenterOf(h);
      return { c, d: Math.hypot(c.x - pivotC.x, c.y - pivotC.y) };
    }).sort((a, b) => b.d - a.d);
    const start = withDist[0].c;

    const th = (25 * Math.PI) / 180; // rotate 25° about the pivot (client == root angle)
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    const target = {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    };
    gestureDrag(start, target);

    const rotDelta = partByLabel('right_arm').rest.rotate - rot0;
    expectClose(Math.cos(((rotDelta - 25) * Math.PI) / 180), 1, 1e-3, 'rest.rotate ≈ 25°');
    expect(state.doc!.clips[0].tracks.length).toBe(0); // Setup never keys
  });
});

describe('scenario 4 — pivot drag compensation', () => {
  it('re-anchors the joint without moving the artwork; one undo restores pivot AND rest tx/ty', () => {
    const part = partByLabel('right_arm');
    part.rest.rotate = 25;
    part.rest.sx = 1.3;
    part.rest.kx = 5;
    selectByLabel('right_arm');
    repaint();

    const g = partGroupEl('right_arm');
    const box = g.getBBox();
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const p0 = applyMat(partMatrix('right_arm'), c.x, c.y);
    const pivot0 = { ...part.pivot };
    const tx0 = part.rest.tx, ty0 = part.rest.ty;

    const pivotC = docToClient(part.pivot);
    const target = { x: pivotC.x + 30, y: pivotC.y - 20 };
    gestureDrag(pivotC, target);

    const after = partByLabel('right_arm');
    // Artwork reference point stays put despite the rotated/scaled/skewed frame.
    const p1 = applyMat(partMatrix('right_arm'), c.x, c.y);
    expectClose(Math.hypot(p1.x - p0.x, p1.y - p0.y), 0, 0.05, 'artwork drift');
    // The joint chased the pointer (effectivePivot == pivot + rest translate in Setup).
    const jointC = docToClient({ x: after.pivot.x + after.rest.tx, y: after.pivot.y + after.rest.ty });
    expectClose(Math.hypot(jointC.x - target.x, jointC.y - target.y), 0, 1, 'joint chases pointer');
    expect(after.pivot.x !== pivot0.x || after.pivot.y !== pivot0.y).toBe(true);

    expect(canUndo()).toBe(true);
    undo();
    const rev = partByLabel('right_arm');
    expectClose(rev.pivot.x, pivot0.x, 1e-9, 'pivot.x restored');
    expectClose(rev.pivot.y, pivot0.y, 1e-9, 'pivot.y restored');
    expectClose(rev.rest.tx, tx0, 1e-9, 'rest.tx restored');
    expectClose(rev.rest.ty, ty0, 1e-9, 'rest.ty restored');
  });
});

describe('scenario 5 — animate auto-key drag', () => {
  it('a plain body drag keys rotate at the playhead', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel('right_arm').id;
    const pt = clientPointOnPart('right_arm');
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 20 });

    const track = clipTrack(id, 'rotate');
    expect(track, 'rotate track created').toBeTruthy();
    expect(track!.keyframes.length).toBeGreaterThanOrEqual(1);
    expect(track!.keyframes[0].time).toBe(0);
    // Rotate-only: no translate tracks from this gesture.
    expect(clipTrack(id, 'tx')).toBeFalsy();
  });

  it('Shift+drag keys tx and ty at the playhead', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel('left_leg').id;
    const pt = clientPointOnPart('left_leg');
    gestureDrag(pt, { x: pt.x + 30, y: pt.y + 24 }, { shiftKey: true });

    expect(clipTrack(id, 'tx'), 'tx track').toBeTruthy();
    expect(clipTrack(id, 'ty'), 'ty track').toBeTruthy();
    expect(clipTrack(id, 'rotate'), 'no rotate track from a Shift+move').toBeFalsy();
  });
});
