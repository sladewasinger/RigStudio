/**
 * Interaction tests for Post-A Fix 2 (grab-point-relative IK, no tip snap — `view/ikDrag.ts`).
 *
 * Prior behavior: the IK drag always used the grabbed bone's TIP as the FABRIK effector,
 * so grabbing anywhere on the bone body teleported the tip to the cursor on the very
 * first move. Fix: the ACTUAL grabbed point (tip, or any body point, or a point on a
 * skinned art surface) is the effector and follows the cursor; the tip trails rigidly
 * beyond a mid-body grab instead of snapping onto it.
 *
 * Full realistic gestures via the harness conventions (elementFromPoint hit targets,
 * intermediate pointermoves); a couple of scenarios need to inspect state after just the
 * FIRST move of a drag (before it completes), so they dispatch pointerdown/pointermove by
 * hand the same way harness.ts's gestureDrag does internally, rather than using its
 * all-in-one helper (which only exposes a hook right before the final pointerup).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { selectPart as modelSelectPart, RigPart } from '../../core/model';
import { renderPose } from '../../view';
import {
  bootRig, resetRig, state, notify, gestureDrag, clientCenterOf, overlayEl, overlayCount,
  expectClose, repaint, medialPoints, placeBoneChain, clientPointOnPart, svgEl, hitAt,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const LIMB = 'right_arm';

/** Place an n-bone chain down a limb's medial axis, nothing selected (free root; the
 *  geometric auto-bind fallback skins the limb). Mirrors bones.test.ts/freeze.test.ts. */
function placeChain(label: string, n: number): RigPart[] {
  modelSelectPart(null);
  notify();
  renderPose();
  return placeBoneChain(medialPoints(label, n));
}

/** The connected-chain invariant (contract (d)) — re-checked after every scenario here. */
function assertNoGap(): void {
  const parts = state.doc?.parts ?? [];
  for (const child of parts) {
    if (child.kind !== 'bone' || !child.parentId) continue;
    const parent = parts.find((p) => p.id === child.parentId && p.kind === 'bone');
    if (!parent || !parent.boneTip) continue;
    expectClose(child.pivot.x + child.rest.tx, parent.boneTip.x, 0.3, 'no gap: child origin x == parent tip x');
    expectClose(child.pivot.y + child.rest.ty, parent.boneTip.y, 0.3, 'no gap: child origin y == parent tip y');
  }
}
afterEach(assertNoGap);

function boneGroupEl(id: string): SVGGElement {
  return svgEl().querySelector<SVGGElement>(`[data-part-id="${id}"]`)!;
}
function localToClient(id: string, lx: number, ly: number): { x: number; y: number } {
  const m = boneGroupEl(id).getScreenCTM()!;
  const pt = svgEl().createSVGPoint();
  pt.x = lx; pt.y = ly;
  const s = pt.matrixTransform(m);
  return { x: s.x, y: s.y };
}
function clientToLocal(id: string, cx: number, cy: number): { x: number; y: number } {
  const m = boneGroupEl(id).getScreenCTM()!.inverse();
  const pt = svgEl().createSVGPoint();
  pt.x = cx; pt.y = cy;
  const s = pt.matrixTransform(m);
  return { x: s.x, y: s.y };
}
function boneOriginClient(b: RigPart): { x: number; y: number } {
  return localToClient(b.id, b.pivot.x, b.pivot.y);
}
function boneTipClient(b: RigPart): { x: number; y: number } {
  return localToClient(b.id, b.boneTip!.x, b.boneTip!.y);
}
/** pivot→tip length of a bone in its own frame. */
function boneLen(b: RigPart): number {
  return b.boneTip ? Math.hypot(b.boneTip.x - b.pivot.x, b.boneTip.y - b.pivot.y) : 0;
}

// Hand-rolled single-step pointer dispatch (mirrors harness.ts's gestureDrag internals)
// so a scenario can inspect state between individual moves instead of only at the end.
function pdown(x: number, y: number): void {
  hitAt(x, y).dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
}
function pmove(x: number, y: number): void {
  svgEl().dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
}
function pup(x: number, y: number): void {
  svgEl().dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
}

describe('scenario IK1 — tip grab tracks the cursor tightly (reachable target)', () => {
  it('grabbing exactly the tip lands it within ~0.5px of a reachable target', () => {
    const [b1, , b3] = placeChain(LIMB, 3);
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const tipStart = boneTipClient(b3);
    const originStart = boneOriginClient(b1);
    // A small nudge PARTWAY back toward the root (a fraction of the current tip→root
    // span, whatever the zoom/geometry happens to be) plus a modest perpendicular
    // offset — guaranteed well inside the chain's reach, unlike a fixed pixel constant.
    const dx = tipStart.x - originStart.x, dy = tipStart.y - originStart.y;
    const to = { x: tipStart.x - dx * 0.15 - dy * 0.08, y: tipStart.y - dy * 0.15 + dx * 0.08 };
    gestureDrag(tipStart, to, { steps: 12 });

    const tipEnd = boneTipClient(b3);
    expectClose(Math.hypot(tipEnd.x - to.x, tipEnd.y - to.y), 0, 0.5, 'tip lands on the cursor');
  });
});

describe('scenario IK2 — mid-body grab is grab-point-relative (no tip snap)', () => {
  it('the tip does NOT snap on the first move, byte-exact bone lengths, and the grabbed point ends on the cursor', () => {
    const [b1, b2, b3] = placeChain(LIMB, 3);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const len0 = [b1, b2, b3].map(boneLen);
    const originC = boneOriginClient(b3);
    const tipC = boneTipClient(b3);
    // A point roughly a third of the way up the bone — genuinely off the tip.
    const grabAt = { x: originC.x + (tipC.x - originC.x) * 0.35, y: originC.y + (tipC.y - originC.y) * 0.35 };
    const grabToTipDist = Math.hypot(tipC.x - grabAt.x, tipC.y - grabAt.y);
    expect(grabToTipDist, 'sanity: the grab point is genuinely off the tip').toBeGreaterThan(8);
    // The bone's local grab coordinate, frozen before any pose change — recomputing its
    // CLIENT position later (through the bone's then-current transform) is how the app's
    // own effectorNow() tracks the grabbed material point, so this is the OBSERVABLE
    // "does the grabbed point follow the cursor" contract, not a reimplementation detail.
    const grabLocal = clientToLocal(b3.id, grabAt.x, grabAt.y);

    pdown(grabAt.x, grabAt.y);
    const firstMove = { x: grabAt.x + 6, y: grabAt.y - 4 }; // past the 3px drag threshold
    pmove(firstMove.x, firstMove.y);

    const tipAfterFirstMove = boneTipClient(b3);
    const tipFirstMoveJump = Math.hypot(tipAfterFirstMove.x - tipC.x, tipAfterFirstMove.y - tipC.y);
    const cursorFirstMoveDist = Math.hypot(firstMove.x - grabAt.x, firstMove.y - grabAt.y);
    // MUTATION-CHECK NOTE: under the old "always tip" behavior, the tip snaps to the
    // cursor immediately — tipFirstMoveJump would already be within ~0.1px of
    // grabToTipDist's full snap distance on this very first move.
    expect(tipFirstMoveJump, 'tip does not snap on the first move')
      .toBeLessThan(cursorFirstMoveDist * 3);

    // A small nudge PARTWAY back toward the chain's root (a fraction of the grab→root
    // span) plus a modest perpendicular offset — guaranteed reachable regardless of the
    // chain's actual on-screen length, unlike a fixed pixel constant (which, for a
    // mid-body grab whose effective "arm" is shorter than the full bone length, can
    // easily exceed the chain's reach and make a tight final-position assertion flaky).
    const originRootC = boneOriginClient(b1);
    const rdx = grabAt.x - originRootC.x, rdy = grabAt.y - originRootC.y;
    const to = { x: grabAt.x - rdx * 0.15 - rdy * 0.08, y: grabAt.y - rdy * 0.15 + rdx * 0.08 };
    for (let i = 2; i <= 10; i++) {
      const t = i / 10;
      pmove(grabAt.x + (to.x - grabAt.x) * t, grabAt.y + (to.y - grabAt.y) * t);
    }
    pup(to.x, to.y);

    // Contract (a): the ACTUAL grabbed point tracks the cursor within ~0.5px.
    const grabFinal = localToClient(b3.id, grabLocal.x, grabLocal.y);
    expectClose(Math.hypot(grabFinal.x - to.x, grabFinal.y - to.y), 0, 0.5, 'grabbed point tracks the cursor');

    // The tip (rigidly further out on the SAME bone) is NOT at the target — proof this
    // isn't secretly still tip-locked.
    const tipFinal = boneTipClient(b3);
    expect(Math.hypot(tipFinal.x - to.x, tipFinal.y - to.y), 'tip is NOT pinned to the cursor')
      .toBeGreaterThan(5);

    // Contract (c): every bone length in the chain stays byte-identical (IK only ever
    // writes rest.rotate).
    [b1, b2, b3].forEach((b, i) => {
      expectClose(boneLen(cur(b.id)), len0[i], 1e-9, `bone ${i + 1} length byte-stable`);
    });
  });
});

describe('scenario IK3 — the IK tool solves the WHOLE chain from a direct tip-handle press', () => {
  it('grabbing the dedicated .bone-tip-handle with the IK tool active rotates every ancestor, not just the leaf', () => {
    const [b1, b2, b3] = placeChain(LIMB, 3);
    state.tool = 'ik';
    modelSelectPart(b3.id); // select the LEAF so its dedicated tip handle renders
    repaint();

    const handle = overlayEl().querySelector('.bone-tip-handle');
    expect(handle, 'the leaf tip handle is present').toBeTruthy();
    const from = clientCenterOf(handle!);

    const rot0 = [b1, b2, b3].map((b) => b.rest.rotate);
    let activeCount = 0;
    gestureDrag(from, { x: from.x - 35, y: from.y + 45 }, {
      steps: 10,
      beforeUp: () => { activeCount = overlayCount('.null-glyph.ik-active'); },
    });

    // MUTATION-CHECK NOTE: without the IK-tool routing, a tip-handle press always runs the
    // classic single-bone aim+stretch (aimBoneAtTip) regardless of tool, which only ever
    // touches the GRABBED bone itself (b3) — b1/b2 would stay untouched and no .ik-active
    // chrome would ever appear (that class is IK-specific).
    expect(activeCount, 'the WHOLE solving chain (all 3 bones) is highlighted mid-drag').toBe(3);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    [b1, b2, b3].forEach((b, i) => {
      expect(Math.abs(cur(b.id).rest.rotate - rot0[i]), `bone ${i + 1} rotated (>0.3°)`)
        .toBeGreaterThan(0.3);
    });
  });
});

describe('scenario IK4 — grabbing a SKINNED ART point is also grab-point-relative', () => {
  it('the bone tip does not snap to the cursor on the first move of an art-surface grab', () => {
    const [, b2] = placeChain(LIMB, 2); // auto-binds LIMB; b2 is deepest → the IK effector
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const tipBefore = boneTipClient(b2);
    const grabAt = clientPointOnPart(LIMB); // a point on the ACTUAL rendered art surface
    const grabToTipDist = Math.hypot(tipBefore.x - grabAt.x, tipBefore.y - grabAt.y);

    pdown(grabAt.x, grabAt.y);
    const firstMove = { x: grabAt.x + 7, y: grabAt.y - 5 };
    pmove(firstMove.x, firstMove.y);

    const tipAfterFirstMove = boneTipClient(b2);
    const tipToCursorDist = Math.hypot(
      tipAfterFirstMove.x - firstMove.x, tipAfterFirstMove.y - firstMove.y,
    );
    // MUTATION-CHECK NOTE: pre-fix, the tip snaps onto the cursor immediately regardless
    // of where on the art you grabbed — tipToCursorDist would already collapse toward 0
    // after this one small move (verified live: 0.09px on a genuine repro). Post-fix, the
    // tip stays wherever the grabbed material point's rigid geometry puts it — far from
    // the cursor unless the grab happened to BE the tip.
    if (grabToTipDist > 5) {
      expect(tipToCursorDist, 'tip does not snap to the cursor on the first move')
        .toBeGreaterThan(3);
    }

    pup(firstMove.x, firstMove.y);
  });
});
