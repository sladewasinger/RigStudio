import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { applyMat } from '../../geometry/transforms';
import { channelValue, Channel } from '../../core/model';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag,
  screenScale, expectClose, docToClient, selectByLabel, overlayEl, overlayCount,
  clientCenterOf, partMatrix, partGroupEl, setEditorMode, clipTrack, repaint, click,
} from './harness';

/** Effective (sampled) channel value at the current time — rest when unkeyed. */
function channelOf(id: string, ch: Channel): number {
  const part = state.doc!.parts.find((p) => p.id === id)!;
  return channelValue(part, ch, state.currentTime);
}

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

describe('scenario 5 — animate unified gizmo body drag (P3 rework)', () => {
  it('a FIRST-click body drag keys tx/ty at the playhead (was rotate)', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel('right_arm').id;
    const pt = clientPointOnPart('right_arm');
    // First click on a part is the translate/scale handle set → body drag TRANSLATES.
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 20 });

    expect(clipTrack(id, 'tx'), 'tx track created').toBeTruthy();
    expect(clipTrack(id, 'ty'), 'ty track created').toBeTruthy();
    expect(clipTrack(id, 'tx')!.keyframes[0].time).toBe(0);
    // Translate-only: no rotate track from the first-click drag.
    expect(clipTrack(id, 'rotate'), 'no rotate track from a first-click drag').toBeFalsy();
  });

  it('a SECOND-click body drag keys rotate at the playhead', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel('right_arm').id;
    // Click to select (scale handle set), then a motionless click on the primary cycles
    // to the rotate/skew handle set — recompute the artwork point each time so the added
    // gizmo chrome never occludes it.
    let pt = clientPointOnPart('right_arm');
    click(pt.x, pt.y);
    pt = clientPointOnPart('right_arm');
    click(pt.x, pt.y);
    // Now a body drag ROTATES.
    pt = clientPointOnPart('right_arm');
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 22 });

    const track = clipTrack(id, 'rotate');
    expect(track, 'rotate track created').toBeTruthy();
    expect(track!.keyframes[0].time).toBe(0);
    expect(clipTrack(id, 'tx'), 'no tx track from the rotate drag').toBeFalsy();
  });

  it('Shift+drag keys tx and ty at the playhead (always translates)', () => {
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

describe('scenario 12 — unified select gizmo (circle rotates, cross translates)', () => {
  function ringHit(): SVGCircleElement {
    const el = overlayEl().querySelector('.select-gizmo .sg-rotate .sg-hit[data-role="gizmo-ring"]');
    if (!el) throw new Error('no gizmo rotate ring rendered');
    return el as SVGCircleElement;
  }
  function crossHit(): SVGRectElement {
    const el = overlayEl().querySelector('.select-gizmo .sg-move .sg-hit[data-gizmo-axis="xy"]');
    if (!el) throw new Error('no gizmo move cross rendered');
    return el as SVGRectElement;
  }
  // The ring/cross carry the root transform on their <g>; cx/cy/r (and rect x/y/w/h) are
  // in root/doc space, so docToClient maps them to client px. Returns the signed value
  // change so the caller asserts exactly.
  function ringDrag(readValue: () => number): number {
    const ring = ringHit();
    const cx = Number(ring.getAttribute('cx'));
    const cy = Number(ring.getAttribute('cy'));
    const r = Number(ring.getAttribute('r'));
    const v0 = readValue();
    const th = (30 * Math.PI) / 180;
    const start = docToClient({ x: cx + r, y: cy });
    const target = docToClient({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) });
    gestureDrag(start, target, { steps: 8 });
    return readValue() - v0;
  }
  function crossDragTranslates(read: () => { tx: number; ty: number }): void {
    const rect = crossHit();
    const x = Number(rect.getAttribute('x'));
    const y = Number(rect.getAttribute('y'));
    const w = Number(rect.getAttribute('width'));
    const h = Number(rect.getAttribute('height'));
    const before = read();
    const start = docToClient({ x: x + w / 2, y: y + h / 2 });
    gestureDrag(start, { x: start.x + 34, y: start.y + 26 });
    const after = read();
    expect(Math.abs(after.tx - before.tx), 'cross moved tx').toBeGreaterThan(0.5);
    expect(Math.abs(after.ty - before.ty), 'cross moved ty').toBeGreaterThan(0.5);
  }

  it('Edit mode: circle drag writes rest.rotate, cross drag writes rest.tx/ty', () => {
    selectByLabel('right_arm');
    repaint();
    const dRot = ringDrag(() => partByLabel('right_arm').rest.rotate);
    expectClose(Math.cos(((dRot - 30) * Math.PI) / 180), 1, 5e-3, 'circle rotates ~30°');
    expect(state.doc!.clips[0].tracks.length).toBe(0); // Edit never keys

    selectByLabel('right_arm');
    repaint();
    crossDragTranslates(() => ({ tx: partByLabel('right_arm').rest.tx, ty: partByLabel('right_arm').rest.ty }));
    expect(state.doc!.clips[0].tracks.length).toBe(0);
  });

  it('Animate mode: circle drag keys rotate, cross drag keys tx/ty', () => {
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel('right_arm').id;
    selectByLabel('right_arm');
    repaint();

    // P5a fix: #timeline now has a FIXED height (splitter-only; see timeline.ts's
    // applyPanelHeight), so the first keyframe lane appearing mid-drag no longer
    // resizes #canvas / shifts its screen CTM — the P3-era harness artifact this
    // scenario used to work around by only checking direction+magnitude. Confirm the
    // canvas geometry really is stable across the very drag that creates the part's
    // first track, then assert the recorded angle near-exactly like the Edit-mode
    // scenario above (same tolerance — the pipeline is otherwise identical).
    const canvasEl = document.getElementById('canvas')!;
    const heightBefore = canvasEl.clientHeight;
    expect(clipTrack(id, 'rotate'), 'no rotate track yet — this drag creates the first lane').toBeFalsy();

    const dRot = ringDrag(() => channelOf(id, 'rotate'));
    expectClose(Math.cos(((dRot - 30) * Math.PI) / 180), 1, 5e-3, 'circle keys ~30° in Animate');
    expect(clipTrack(id, 'rotate'), 'rotate keyed by the gizmo circle').toBeTruthy();
    expect(
      canvasEl.clientHeight,
      '#canvas height unchanged by the first lane appearing mid-drag',
    ).toBe(heightBefore);

    selectByLabel('right_arm');
    repaint();
    crossDragTranslates(() => ({ tx: channelOf(id, 'tx'), ty: channelOf(id, 'ty') }));
    expect(clipTrack(id, 'tx'), 'tx keyed by the gizmo cross').toBeTruthy();
    expect(clipTrack(id, 'ty'), 'ty keyed by the gizmo cross').toBeTruthy();
  });
});

describe('scenario 8 — rotate drag crossing the ±180° ray (P2b bug fix)', () => {
  it('records the short-way delta, not a ~360° jump', () => {
    selectByLabel('right_arm');
    state.tool = 'rotate';
    repaint();

    const ring = overlayEl().querySelector('[data-role="gizmo-ring"]') as SVGCircleElement | null;
    if (!ring) throw new Error('no gizmo-ring rendered');
    // Read the ring's geometry straight from its SVG attributes (root/document space,
    // same frame as effectivePivot) rather than getBoundingClientRect, which would
    // include the (screen-constant, 12px) hit-stroke and throw off the exact radius.
    const cx = Number(ring.getAttribute('cx'));
    const cy = Number(ring.getAttribute('cy'));
    const r = Number(ring.getAttribute('r'));
    const ptAt = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return docToClient({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    };

    const rot0 = partByLabel('right_arm').rest.rotate;
    // Both endpoints sit at the SAME client x (mirrored across the pivot's negative-x
    // ray), so the straight-line chord gestureDrag interpolates sweeps smoothly
    // THROUGH angle=180° — the atan2 branch cut — a real multi-step gesture going the
    // SHORT way (20°) across the ray. The old raw-diff implementation instead reads
    // the down→up angle difference as (-170 - 170) = -340°.
    gestureDrag(ptAt(170), ptAt(-170), { steps: 12 });

    const rotDelta = partByLabel('right_arm').rest.rotate - rot0;
    expectClose(rotDelta, 20, 8, 'rotate crossing ±180° records the short-way delta');
    expect(Math.abs(rotDelta)).toBeLessThan(60); // nowhere near the ~340°/360° bug magnitude
  });
});
