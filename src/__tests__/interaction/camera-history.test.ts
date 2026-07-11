import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../history';
import { zoomBy } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  screenScale, expectClose, clientToDoc, viewBox, wheelAt, count, svgEl,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const round1 = (n: number) => Math.round(n * 10) / 10;

describe('scenario 10 — snapping translate drag', () => {
  it('snaps a pivot onto another pivot (byte-equal landing); marker lives only mid-drag', () => {
    state.snapEnabled = true;
    const scale = screenScale();
    const pa = { ...partByLabel('face').pivot };      // effectivePivot == pivot in Setup
    const pb = { ...partByLabel('left_leg').pivot };  // the snap target (a far, non-congruent part)
    const dir = { x: pb.x - pa.x, y: pb.y - pa.y };
    const dlen = Math.hypot(dir.x, dir.y);
    // Aim so the moving pivot lands ~2px short of the target — inside the 8px threshold
    // — so snapping completes the alignment exactly.
    const short = 2;
    const clientDelta = {
      x: dir.x * scale - (dir.x / dlen) * short,
      y: dir.y * scale - (dir.y / dlen) * short,
    };

    const from = clientPointOnPart('face');
    let markerSeen = 0;
    gestureDrag(
      from,
      { x: from.x + clientDelta.x, y: from.y + clientDelta.y },
      { beforeUp: () => { markerSeen = count('.snap-marker'); } },
    );

    const face = partByLabel('face');
    expect(face.rest.tx).toBe(round1(pb.x - pa.x)); // byte-equal snapped landing
    expect(face.rest.ty).toBe(round1(pb.y - pa.y));
    expect(markerSeen).toBe(1);          // snap marker drawn during the drag
    expect(count('.snap-marker')).toBe(0); // and cleared on pointerup
  });

  it('Ctrl freezes the non-dominant axis', () => {
    state.snapEnabled = true;
    const from = clientPointOnPart('left_leg');
    // Mostly-horizontal move with Ctrl → the y channel must stay byte-identical.
    gestureDrag(from, { x: from.x + 70, y: from.y + 12 }, { ctrlKey: true });
    const part = partByLabel('left_leg');
    expect(part.rest.ty).toBe(0);          // frozen axis untouched
    expect(Math.abs(part.rest.tx)).toBeGreaterThan(1); // dominant axis moved
  });
});

describe('scenario 11 — camera invariants', () => {
  it('wheel zoom keeps the cursor’s document point fixed', () => {
    const raw = clientPointOnPart('body');
    // Integer client coords: the browser reports WheelEvent.clientX/Y as integers, so
    // anchor and measurement must use the same rounded cursor point.
    const cx = Math.round(raw.x), cy = Math.round(raw.y);
    const before = clientToDoc(cx, cy);
    wheelAt(cx, cy, -120); // zoom in at the cursor
    const after = clientToDoc(cx, cy);
    expectClose(Math.hypot(after.x - before.x, after.y - before.y), 0, 0.01, 'cursor doc-point');
  });

  it('zoomBy(1.25) applies an exact 1.25 ratio with zero center drift', () => {
    const rect = svgEl().getBoundingClientRect();
    const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const before = clientToDoc(c.x, c.y);
    const w0 = viewBox().w, h0 = viewBox().h;
    zoomBy(1.25);
    const w1 = viewBox().w, h1 = viewBox().h;
    expectClose(w0 / w1, 1.25, 1e-9, 'width ratio');
    expectClose(h0 / h1, 1.25, 1e-9, 'height ratio');
    const after = clientToDoc(c.x, c.y);
    expectClose(Math.hypot(after.x - before.x, after.y - before.y), 0, 0.01, 'center drift');
  });
});

describe('scenario 12 — checkpoint deferral', () => {
  it('a plain click makes no history; one drag makes exactly one entry', () => {
    expect(canUndo()).toBe(false); // fresh document, clean history

    const pt = clientPointOnPart('left_leg');
    click(pt.x, pt.y); // selects, but no movement → no checkpoint
    expect(canUndo()).toBe(false);

    const tx0 = partByLabel('left_leg').rest.tx;
    gestureDrag(pt, { x: pt.x + 40, y: pt.y + 20 }); // one gesture
    expect(canUndo()).toBe(true);
    expect(partByLabel('left_leg').rest.tx).not.toBe(tx0);

    // Exactly one entry: one undo restores the pristine value AND empties the stack.
    undo();
    expect(partByLabel('left_leg').rest.tx).toBe(tx0); // re-read after undo
    expect(canUndo()).toBe(false);
  });
});
