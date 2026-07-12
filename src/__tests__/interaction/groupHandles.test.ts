/**
 * Interaction tests for "Group handle sets" (ROADMAP.md): a selected GROUP-kind part
 * (partless — Ctrl+G nulls and imported nested wrapper groups alike) used to draw only
 * the passive dashed union box, with no way to tell scale mode from rotate mode — the
 * visible-counterpart GOTCHA in CLAUDE.md. First click now shows 8 scale handles around
 * the union bbox of the group's descendants, dragging one applies a DISTRIBUTED rest
 * edit (rest.sx/sy multiply, rest.tx/ty adjust so every descendant's rendered position
 * scales about the group's OWN effective pivot — the flipSelected family generalized
 * from reflection to scale, view/rigOps.ts's applyGroupScale). Second click shows 4
 * rotate corners (no skew — groups have no shear field) that write the group's OWN
 * rest.rotate, which genuinely propagates through the pose chain like today.
 *
 * Real gestures throughout (elementFromPoint hit targets, full pointer sequences,
 * numeric assertions) per the harness conventions.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { ancestorChain } from '../../core/model';
import { partRootBoxes, resetView } from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  clientCenterOf, overlayEl, overlayCount, expectClose, docToClient, selectByLabel,
  setEditorMode, clipTrack, repaint, loadFixtureSvg, assertScreenConstant,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/**
 * Ctrl+G left_arm + right_arm into a fresh group via the REAL gesture (click,
 * Shift+click, groupAction) — mirrors selection-focus.test.ts's scenario 9. The group
 * ends up the primary selection with handleMode freshly reset to 'scale' (overlay.ts's
 * selection-change reset).
 */
function makeGroup() {
  const laId = partByLabel('left_arm').id;
  const raId = partByLabel('right_arm').id;
  let p = clientPointOnPart('left_arm');
  click(p.x, p.y);
  p = clientPointOnPart('right_arm');
  click(p.x, p.y, { shiftKey: true });
  groupAction();
  const group = state.doc!.parts.find((pt) => pt.kind === 'group')!;
  expect(group, 'groupAction produced a group part').toBeTruthy();
  expect(state.selectedPartId).toBe(group.id);
  return { group, childIds: [laId, raId] };
}

/** Farthest rotate-corner handle from the pivot (clean lever arm), client-space. */
function farthestRotateHandle(pivotC: { x: number; y: number }): { x: number; y: number } {
  const handles = Array.from(overlayEl().querySelectorAll('[data-role="rotate-handle"]'));
  expect(handles.length).toBe(4);
  const withDist = handles.map((h) => {
    const c = clientCenterOf(h);
    return { c, d: Math.hypot(c.x - pivotC.x, c.y - pivotC.y) };
  }).sort((a, b) => b.d - a.d);
  return withDist[0].c;
}

describe('scenario G1 — group scale handles (8 corners/sides), a distributed rest edit', () => {
  it('shows 8 scale handles; an SE-corner drag ~1.2x scales every descendant about the group pivot; one undo restores byte-exact', () => {
    const { group, childIds } = makeGroup();
    expect(overlayCount('.scale-handle')).toBe(8);
    expect(overlayCount('.rotate-handle')).toBe(0);
    expect(group.rest.sx).toBe(1);
    expect(group.rest.sy).toBe(1);

    const before = childIds.map((id) => {
      const part = state.doc!.parts.find((p) => p.id === id)!;
      return { id, sx: part.rest.sx, sy: part.rest.sy, tx: part.rest.tx, ty: part.rest.ty };
    });
    const boxesBefore = partRootBoxes(childIds);
    const pivot0 = { ...group.pivot };

    const seC = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const pivotC = docToClient(group.pivot);
    const k = 1.2;
    // Drag exactly along the pivot→SE ray so fx == fy == k precisely (sidesteps the
    // non-uniform-scale-of-rotated-art caveat documented on applyGroupScale).
    const target = {
      x: pivotC.x + k * (seC.x - pivotC.x),
      y: pivotC.y + k * (seC.y - pivotC.y),
    };
    gestureDrag(seC, target);

    const group2 = state.doc!.parts.find((p) => p.id === group.id)!;
    expectClose(group2.rest.sx, 1, 1e-9, 'group rest.sx stays untouched/meaningless');
    expectClose(group2.rest.sy, 1, 1e-9, 'group rest.sy stays untouched/meaningless');
    expectClose(group2.pivot.x, pivot0.x, 1e-9, 'group pivot unchanged');
    expectClose(group2.pivot.y, pivot0.y, 1e-9, 'group pivot unchanged');

    const boxesAfter = partRootBoxes(childIds);
    for (const b of before) {
      const part = state.doc!.parts.find((p) => p.id === b.id)!;
      expectClose(part.rest.sx, b.sx * k, 0.05, `${b.id} rest.sx scaled ~${k}x`);
      expectClose(part.rest.sy, b.sy * k, 0.05, `${b.id} rest.sy scaled ~${k}x`);

      const b0 = boxesBefore.get(b.id)!;
      const b1 = boxesAfter.get(b.id)!;
      expectClose(b1.w, b0.w * k, Math.max(0.5, b0.w * 0.06), `${b.id} rendered bbox width scaled ~${k}x`);
      expectClose(b1.h, b0.h * k, Math.max(0.5, b0.h * 0.06), `${b.id} rendered bbox height scaled ~${k}x`);
      // A true scale-about-pivot: the bbox's own corner maps to pivot + k*(corner -
      // pivot) — "a descendant far from the pivot moved proportionally", asserted
      // exactly rather than merely "it moved".
      const expX0 = pivot0.x + k * (b0.x - pivot0.x);
      const expY0 = pivot0.y + k * (b0.y - pivot0.y);
      expectClose(b1.x, expX0, Math.max(0.5, Math.abs(expX0) * 0.03), `${b.id} bbox origin scaled about the pivot (x)`);
      expectClose(b1.y, expY0, Math.max(0.5, Math.abs(expY0) * 0.03), `${b.id} bbox origin scaled about the pivot (y)`);
    }

    expect(canUndo()).toBe(true);
    undo();
    for (const b of before) {
      const part = state.doc!.parts.find((p) => p.id === b.id)!; // re-read: undo swaps the doc object
      expectClose(part.rest.sx, b.sx, 1e-9, `${b.id} rest.sx restored`);
      expectClose(part.rest.sy, b.sy, 1e-9, `${b.id} rest.sy restored`);
      expectClose(part.rest.tx, b.tx, 1e-9, `${b.id} rest.tx restored`);
      expectClose(part.rest.ty, b.ty, 1e-9, `${b.id} rest.ty restored`);
    }
  });

  it('an imported nested group (girl_example.svg, RightArm — a genuinely partless import, unlike Pip\'s body-in-body which stays kind "art") also gets scale handles that distribute across every descendant', async () => {
    await loadFixtureSvg('girl_example.svg', 'girl');
    const group = state.doc!.parts.find((p) => p.label === 'RightArm')!;
    expect(group, 'RightArm present in girl_example.svg').toBeTruthy();
    expect(group.kind, 'RightArm imports as a partless group (no direct paths of its own)').toBe('group');

    selectByLabel('RightArm');
    repaint();
    expect(overlayCount('.scale-handle')).toBe(8);

    const descendantIds = state.doc!.parts
      .filter((p) => p.paths.length > 0 && ancestorChain(p).some((a) => a.id === group.id))
      .map((p) => p.id);
    expect(descendantIds.length, 'RightArm has descendant artwork (Arm, g291-2, g289)').toBeGreaterThan(0);

    const before = descendantIds.map((id) => {
      const part = state.doc!.parts.find((p) => p.id === id)!;
      return { id, sx: part.rest.sx, sy: part.rest.sy };
    });
    const boxesBefore = partRootBoxes(descendantIds);
    const pivot0 = { ...group.pivot };

    const seC = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const pivotC = docToClient(group.pivot);
    const k = 1.25;
    const target = {
      x: pivotC.x + k * (seC.x - pivotC.x),
      y: pivotC.y + k * (seC.y - pivotC.y),
    };
    gestureDrag(seC, target);

    const boxesAfter = partRootBoxes(descendantIds);
    for (const b of before) {
      const part = state.doc!.parts.find((p) => p.id === b.id)!;
      expectClose(part.rest.sx, b.sx * k, 0.06, `${b.id} rest.sx scaled ~${k}x`);
      expectClose(part.rest.sy, b.sy * k, 0.06, `${b.id} rest.sy scaled ~${k}x`);
      const b0 = boxesBefore.get(b.id)!;
      const b1 = boxesAfter.get(b.id)!;
      expectClose(b1.w, b0.w * k, Math.max(0.5, b0.w * 0.06), `${b.id} bbox width scaled ~${k}x`);
      const expX0 = pivot0.x + k * (b0.x - pivot0.x);
      const expY0 = pivot0.y + k * (b0.y - pivot0.y);
      expectClose(b1.x, expX0, Math.max(0.5, Math.abs(expX0) * 0.04), `${b.id} bbox scaled about the pivot (x)`);
      expectClose(b1.y, expY0, Math.max(0.5, Math.abs(expY0) * 0.04), `${b.id} bbox scaled about the pivot (y)`);
    }

    expect(canUndo()).toBe(true);
    undo();
    for (const b of before) {
      const part = state.doc!.parts.find((p) => p.id === b.id)!;
      expectClose(part.rest.sx, b.sx, 1e-9, `${b.id} rest.sx restored`);
      expectClose(part.rest.sy, b.sy, 1e-9, `${b.id} rest.sy restored`);
    }
  });
});

describe('scenario G2 — group rotate handles (second click): no skew, group\'s own rest.rotate', () => {
  it('toggles to 4 rotate corners with 0 skew/0 scale handles (DOM difference, GOTCHA); a drag writes the GROUP\'s rest.rotate and children ride it', () => {
    const { group, childIds } = makeGroup();
    expect(overlayCount('.scale-handle')).toBe(8);

    // A motionless click on a CHILD's artwork resolves to the (already-primary) closed
    // group — group-aware selection, same as any other body click — and toggles the
    // handle set, exactly like clicking an art part's own body a second time.
    const p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    expect(overlayCount('.scale-handle'), 'scale set gone').toBe(0);
    expect(overlayCount('.skew-handle'), 'groups never show skew').toBe(0);
    expect(overlayCount('.rotate-handle'), '4 rotate corners visible').toBe(4);

    const rot0 = group.rest.rotate;
    const pivotC = docToClient(group.pivot);
    const start = farthestRotateHandle(pivotC);
    const th = (25 * Math.PI) / 180; // rotate 25° about the pivot
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    const target = {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    };

    const leftArm = state.doc!.parts.find((pp) => pp.id === childIds[0])!;
    const armBoxBefore = partRootBoxes([leftArm.id]).get(leftArm.id)!;

    gestureDrag(start, target);

    const group2 = state.doc!.parts.find((pp) => pp.id === group.id)!;
    const rotDelta = group2.rest.rotate - rot0;
    expectClose(Math.cos(((rotDelta - 25) * Math.PI) / 180), 1, 1e-3, 'group rest.rotate advances ~25°');
    expect(state.doc!.clips[0].tracks.length).toBe(0); // Setup never keys

    const armBoxAfter = partRootBoxes([leftArm.id]).get(leftArm.id)!;
    expect(
      Math.hypot(armBoxAfter.x - armBoxBefore.x, armBoxAfter.y - armBoxBefore.y),
      'child rides the group rotate through the pose chain',
    ).toBeGreaterThan(2);

    expect(canUndo()).toBe(true);
    undo();
    const restored = state.doc!.parts.find((pp) => pp.id === group.id)!;
    expectClose(restored.rest.rotate, rot0, 1e-9, 'group rest.rotate restored');
  });
});

describe('scenario G3 — Animate mode: group rotate handles key the group\'s rotate', () => {
  it('first click (handleMode "scale") shows the passive box, no rotate handles; second click shows 4 rotate corners and a drag keys rotate at the playhead', () => {
    const { group } = makeGroup(); // Setup, freshly selected, handleMode 'scale'
    setEditorMode('animate');
    state.currentTime = 0;
    repaint();

    // handleMode carries over from Setup — Animate's "first click" state (scale isn't
    // keyable) stays the plain passive box, same as an art part.
    expect(overlayCount('.rotate-handle'), 'no rotate handles on the first (scale) handleMode').toBe(0);
    expect(overlayCount('.scale-handle'), 'scale handles are Edit-only').toBe(0);

    const p = clientPointOnPart('left_arm');
    click(p.x, p.y); // motionless click on the already-primary group toggles the set
    expect(overlayCount('.rotate-handle'), '4 rotate handles visible on the second click').toBe(4);
    expect(overlayCount('.skew-handle'), 'skew stays Edit-only, and groups never show it').toBe(0);

    const pivotC = docToClient(group.pivot); // Setup rest untouched yet — effectivePivot == pivot
    const start = farthestRotateHandle(pivotC);
    const th = (25 * Math.PI) / 180;
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    const target = {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    };
    expect(clipTrack(group.id, 'rotate'), 'no rotate track yet').toBeFalsy();

    gestureDrag(start, target);

    const track = clipTrack(group.id, 'rotate');
    expect(track, 'group rotate keyed by the rotate-handle drag').toBeTruthy();
    expect(track!.keyframes[0].time).toBe(0);
    const finalValue = track!.keyframes[0].value;
    expectClose(Math.cos(((finalValue - 25) * Math.PI) / 180), 1, 1e-3, 'keyed rotate ~= 25° (rest.rotate started at 0)');
  });
});

describe('scenario G4 — group handles stay screen-constant across a zoom sweep (GOTCHA guard)', () => {
  it('scale handles and rotate handles hold their on-screen size from fit to ~8x zoom', () => {
    makeGroup();
    resetView();
    repaint();
    assertScreenConstant('.scale-handle');

    resetView();
    const p = clientPointOnPart('left_arm');
    click(p.x, p.y); // toggle to the rotate set
    resetView();
    assertScreenConstant('[data-role="rotate-handle"]');
  });
});
