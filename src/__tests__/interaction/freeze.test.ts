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

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { selectPart as modelSelectPart } from '../../core/model';
import { renderPose } from '../../view';
import {
  bootRig, resetRig, state, notify, partByLabel, partGroupEl, gestureDrag, docToClient,
  clientCenterOf, overlayEl, overlayCount, expectClose, selectByLabel, repaint, pressKey,
  medialPoints, placeBoneChain, assertScreenConstant, enterNodeMode,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Place an n-bone chain down a limb's medial axis with the pen tool, nothing selected
 *  (mirrors bones.test.ts's helper — N+1 medial points → N connected bones). */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  modelSelectPart(null);
  notify();
  renderPose();
  return placeBoneChain(medialPoints(label, n));
}

/** Concatenated rendered `d` of a skinned part's paths (the serialized LBS geometry). */
function renderedD(label: string): string {
  return Array.from(partGroupEl(label).querySelectorAll('path'))
    .map((p) => p.getAttribute('d') ?? '').join('|');
}
function boneLen(b: ReturnType<typeof partByLabel>): number {
  return b.boneTip ? Math.hypot(b.boneTip.x - b.pivot.x, b.boneTip.y - b.pivot.y) : 0;
}

/** The connected-chain invariant — a child bone's origin never leaves its parent's tip.
 *  SCOPED to chain-internal links: an `attachedRoot` cross-chain attach is deliberately
 *  loose (Unified Skeleton Phase 1), so it's excluded rather than asserted against. */
function assertNoGap(): void {
  const parts = state.doc?.parts ?? [];
  for (const child of parts) {
    if (child.kind !== 'bone' || !child.parentId || child.attachedRoot) continue;
    const parent = parts.find((p) => p.id === child.parentId && p.kind === 'bone');
    if (!parent || !parent.boneTip) continue;
    expectClose(child.pivot.x + child.rest.tx, parent.boneTip.x, 0.3, 'no gap: child origin x == parent tip x');
    expectClose(child.pivot.y + child.rest.ty, parent.boneTip.y, 0.3, 'no gap: child origin y == parent tip y');
  }
}
afterEach(assertNoGap);

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

describe('scenario F2 — the freeze DISTINCTION for a chain joint (deform vs. static art)', () => {
  // RE-SPEC (v2.13 bone rework): a child bone's origin IS the shared joint with its parent's
  // tip, so it is LIVE in BOTH modes — dragging it always moves the joint and carries the
  // parent tip (chain stays connected). The mode only changes what the ART does: OUTSIDE
  // freeze it deforms (posing the limb), INSIDE freeze it stays byte-stable (fitting the rig
  // to static art via the bind refresh). This replaces the old "inert outside freeze" gate.
  it('OFF freeze: the joint drag moves the joint AND deforms the skinned art', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    state.tool = 'select';
    modelSelectPart(b2.id); // select the CHILD; its origin is the shared joint
    notify();
    repaint();

    const pivot0 = { ...cur(b2.id).pivot };
    const artBefore = renderedD('left_leg');
    const from = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    gestureDrag(from, { x: from.x + 28, y: from.y + 22 }, { steps: 10 });

    expect(Math.hypot(cur(b2.id).pivot.x - pivot0.x, cur(b2.id).pivot.y - pivot0.y),
      'joint moved off freeze').toBeGreaterThan(0.3);
    expectClose(cur(b1.id).boneTip!.x, cur(b2.id).pivot.x, 0.3, 'parent tip tracks the joint');
    expectClose(cur(b1.id).boneTip!.y, cur(b2.id).pivot.y, 0.3, 'parent tip tracks the joint');
    expect(renderedD('left_leg'), 'skinned art deformed off freeze').not.toBe(artBefore);
  });

  it('ON freeze: the same joint drag moves the joint but leaves the art byte-identical', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    state.tool = 'select';
    pressKey('y'); // freeze BEFORE any posing → the art is at its bind appearance
    modelSelectPart(b2.id);
    notify();
    repaint();

    const pivot0 = { ...cur(b2.id).pivot };
    const artFrozen = renderedD('left_leg');
    const from = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    gestureDrag(from, { x: from.x + 28, y: from.y + 22 }, { steps: 10 });

    expect(Math.hypot(cur(b2.id).pivot.x - pivot0.x, cur(b2.id).pivot.y - pivot0.y),
      'joint moved inside freeze').toBeGreaterThan(0.3);
    expectClose(cur(b1.id).boneTip!.x, cur(b2.id).pivot.x, 0.3, 'parent tip followed the joint');
    expectClose(cur(b1.id).boneTip!.y, cur(b2.id).pivot.y, 0.3, 'parent tip followed the joint');
    expect(renderedD('left_leg'), 'art byte-identical inside freeze (bind refreshed each move)')
      .toBe(artFrozen);
  });
});

describe('scenario F5 — freeze holds the CURRENT (already-posed) look static, not the rest', () => {
  it('after non-freeze posing deforms the limb, entering freeze keeps THAT deformed look static while the bone moves', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;

    // Pose in NON-freeze: rotate the root bone so the skinned limb is visibly deformed away
    // from its bind/rest appearance.
    modelSelectPart(b1.id);
    notify();
    cur(b1.id).rest.rotate = 22;
    repaint();
    const deformed = renderedD('left_leg');

    // Enter freeze and reshape a bone. The limb must stay on the DEFORMED look (the
    // captureFrozenBaseline baseline), NOT snap back to the un-posed rest geometry.
    pressKey('y');
    state.tool = 'select';
    modelSelectPart(b2.id);
    repaint();
    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(tipC, { x: tipC.x + 40, y: tipC.y - 26 }, { steps: 10 });

    expect(renderedD('left_leg'), 'freeze holds the CURRENT deformed look, not the rest look')
      .toBe(deformed);
    expect(Math.abs(cur(b2.id).rest.rotate) + Math.hypot(
      cur(b2.id).boneTip!.x - cur(b2.id).pivot.x, cur(b2.id).boneTip!.y - cur(b2.id).pivot.y,
    ), 'the bone actually moved').toBeGreaterThan(0);
  });
});

describe('scenario F4 — freeze tip reshape: static art, then pose from the NEW bind', () => {
  it('a freeze tip drag reshapes the bone with the art byte-stable; exiting freeze, a rotation deforms from the new bind', () => {
    const [b1] = placeChain('left_leg', 1); // single bone, a leaf tip
    const cur = () => state.doc!.parts.find((p) => p.id === b1.id)!;
    state.tool = 'select';
    pressKey('y'); // freeze (art at bind appearance)
    modelSelectPart(b1.id);
    repaint();

    const artFrozen = renderedD('left_leg');
    const len0 = boneLen(cur());
    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(tipC, { x: tipC.x + 46, y: tipC.y - 30 }, { steps: 10 });

    const reshaped = boneLen(cur()) !== len0 || cur().rest.rotate !== 0;
    expect(reshaped, 'the bone was reshaped (aim/length changed)').toBe(true);
    expect(renderedD('left_leg'), 'art byte-identical across the freeze reshape').toBe(artFrozen);

    // Exit freeze and pose it (non-freeze): the art now deforms from the NEW bind pose.
    pressKey('Escape');
    expect(state.freezeMode, 'Escape left freeze').toBe(false);
    cur().rest.rotate += 30;
    repaint();
    expect(renderedD('left_leg'), 'a non-freeze rotation deforms from the new bind').not.toBe(artFrozen);
  });
});

describe("scenario F6 — a parent tip reshape preserves the CHILD bone's own length/direction (freeze)", () => {
  it('dragging the parent tip carries the child origin without shortening/lengthening the child', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    pressKey('y'); // freeze — isolates the geometry carry from the art's bind-refresh
    modelSelectPart(b1.id);
    repaint();

    const tip0 = { ...cur(b1.id).boneTip! };
    const len0 = boneLen(cur(b2.id));
    const tipVec0 = {
      x: cur(b2.id).boneTip!.x - cur(b2.id).pivot.x,
      y: cur(b2.id).boneTip!.y - cur(b2.id).pivot.y,
    };

    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(tipC, { x: tipC.x + 60, y: tipC.y - 45 }, { steps: 10 });

    const moved = Math.hypot(cur(b1.id).boneTip!.x - tip0.x, cur(b1.id).boneTip!.y - tip0.y);
    expect(moved, 'the parent tip actually moved substantially').toBeGreaterThan(10);

    const len1 = boneLen(cur(b2.id));
    const tipVec1 = {
      x: cur(b2.id).boneTip!.x - cur(b2.id).pivot.x,
      y: cur(b2.id).boneTip!.y - cur(b2.id).pivot.y,
    };
    expectClose(len1, len0, 0.01, "child bone's own length unchanged (freeze)");
    expectClose(tipVec1.x, tipVec0.x, 0.01, 'child local tip vector x unchanged (freeze)');
    expectClose(tipVec1.y, tipVec0.y, 0.01, 'child local tip vector y unchanged (freeze)');
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

// ---- Post-A Fix 1: freeze origin-drag no longer requires pre-selecting the bone ----

describe('scenario F7 — freeze origin-drag on an UNSELECTED bone (Post-A Fix 1)', () => {
  it('a press on the ROOT origin of an unselected bone selects it AND moves the joint in one gesture — never rotates', () => {
    const [b1] = placeChain('left_leg', 2);
    pressKey('y'); // freeze
    modelSelectPart(null);
    notify();
    repaint();
    expect(state.selectedPartId, 'nothing selected before the press').toBeNull();

    // MUTATION-CHECK NOTE: before the fix, no data-role="pivot" element exists for an
    // unselected bone at all — this querySelector would find nothing, and the press
    // would fall through to the glyph's body-drag (rotate) pipeline instead.
    const marker = overlayEl().querySelector(`[data-role="pivot"][data-part-id="${b1.id}"]`);
    expect(marker, 'a freeze-mode origin marker exists for the UNSELECTED root bone').toBeTruthy();
    const from = clientCenterOf(marker!);
    const rot0 = b1.rest.rotate;
    const pivot0 = { ...b1.pivot };

    gestureDrag(from, { x: from.x + 34, y: from.y - 26 }, { steps: 10 });

    const cur = state.doc!.parts.find((p) => p.id === b1.id)!;
    expect(state.selectedPartId, 'the press selected the bone in the SAME gesture').toBe(b1.id);
    expect(cur.rest.rotate, 'rest.rotate untouched — a JOINT MOVE, not a body rotate').toBe(rot0);
    const moved = Math.hypot(cur.pivot.x - pivot0.x, cur.pivot.y - pivot0.y);
    expect(moved, 'the joint (pivot) actually moved').toBeGreaterThan(0.3);
  });

  it('a press on a SHARED JOINT (unselected child origin) selects it AND reshapes the parent tip', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    pressKey('y');
    modelSelectPart(null);
    notify();
    repaint();

    const marker = overlayEl().querySelector(`[data-role="pivot"][data-part-id="${b2.id}"]`);
    expect(marker, 'a freeze-mode origin marker exists for the unselected CHILD bone').toBeTruthy();
    const from = clientCenterOf(marker!);
    const tip0 = { ...b1.boneTip! };

    gestureDrag(from, { x: from.x + 30, y: from.y + 24 }, { steps: 10 });

    const cur1 = state.doc!.parts.find((p) => p.id === b1.id)!;
    const cur2 = state.doc!.parts.find((p) => p.id === b2.id)!;
    expect(state.selectedPartId, 'the press selected the CHILD bone').toBe(b2.id);
    const moved = Math.hypot(cur1.boneTip!.x - tip0.x, cur1.boneTip!.y - tip0.y);
    expect(moved, 'the shared joint (parent tip) actually moved').toBeGreaterThan(0.3);
    expectClose(cur2.pivot.x, cur1.boneTip!.x, 0.3, 'child origin tracks the new joint');
    expectClose(cur2.pivot.y, cur1.boneTip!.y, 0.3, 'child origin tracks the new joint');
  });

  it('a press on an unselected bone origin OUTSIDE freeze is UNCHANGED (still selects + rotates)', () => {
    // "Outside freeze, behavior is UNCHANGED" — no origin markers render for anything but
    // the selected part, so the press still falls through to the ordinary body/glyph
    // click pipeline (select + rotate), exactly as before this wave.
    const [b1] = placeChain('left_leg', 2);
    modelSelectPart(null);
    notify();
    repaint();
    expect(state.freezeMode).toBe(false);

    const marker = overlayEl().querySelector(`[data-role="pivot"][data-part-id="${b1.id}"]`);
    expect(marker, 'no freeze-mode-only marker exists outside freeze').toBeFalsy();

    const glyph = overlayEl().querySelector(`[data-part-id="${b1.id}"]`)!;
    const from = clientCenterOf(glyph);
    const rot0 = b1.rest.rotate;
    gestureDrag(from, { x: from.x + 34, y: from.y - 26 }, { steps: 10 });
    const cur = state.doc!.parts.find((p) => p.id === b1.id)!;
    expect(state.selectedPartId, 'still selects on press (unchanged)').toBe(b1.id);
    expect(cur.rest.rotate, 'still rotates the body (unchanged outside freeze)').not.toBe(rot0);
  });
});

describe('scenario F8 — visible counterpart: freeze renders an origin marker for EVERY bone', () => {
  it('marker count jumps from "selected only" to "every bone" when freeze toggles on, and back off', () => {
    const bones = placeChain('left_leg', 3); // 3 bones, none selected after placement
    modelSelectPart(null);
    notify();
    repaint();

    expect(state.freezeMode).toBe(false);
    expect(overlayCount('[data-role="pivot"]'), 'no markers with nothing selected, freeze off').toBe(0);

    pressKey('y');
    repaint();
    expect(overlayCount('[data-role="pivot"]'), 'every bone gets a marker once freeze is on')
      .toBe(bones.length);

    // Selecting one bone still shows exactly one marker each for the OTHER bones plus the
    // primary's own (richer) crosshair — same total count, no double-marker on the primary.
    modelSelectPart(bones[1].id);
    notify();
    repaint();
    expect(overlayCount('[data-role="pivot"]'), 'selecting one bone keeps the count at N (no duplicate)')
      .toBe(bones.length);

    pressKey('Escape'); // leaves freeze
    expect(state.freezeMode).toBe(false);
    repaint();
    expect(overlayCount('[data-role="pivot"]'), 'back down to just the selected bone\'s marker')
      .toBe(1);
  });
});

describe('scenario F9 — freeze origin markers are screen-constant (GOTCHA guard)', () => {
  it('an unselected bone\'s freeze-mode origin marker holds its on-screen size across a zoom sweep', () => {
    placeChain('left_leg', 2);
    modelSelectPart(null);
    notify();
    pressKey('y');
    repaint();
    assertScreenConstant('.pivot-handle.other .pivot-ring');
  });
});

describe('scenario F10 — freeze origin-drag on an unselected bone survives node-editing mode (regression)', () => {
  it('a press on an unselected bone\'s origin while the owning part is node-edited selects it AND moves the joint — never bends the outline', () => {
    // Node editing shows the edited part's own bone chain too (CLAUDE.md "bones visible
    // in node mode"), so freeze-editing a joint while fine-tuning the mesh is a real,
    // expected workflow — but overlay.ts's node-mode branch renders bone GLYPHS
    // (appendNullGlyph) without ever calling renderFreezeJointMarkers, so an unselected
    // bone's origin has NO [data-role="pivot"] element there at all, regardless of
    // freeze. The press falls through PIVOT_PIPELINE (nothing to claim) into
    // NODE_BEND_MARQUEE_PIPELINE, which — because a bone's origin usually sits close to
    // the limb's own silhouette — frequently finds a nearby segment and BENDS the path
    // instead (verified live: dragging left_leg's root-bone origin in this state
    // rewrites path.d while pivot/rest.tx/ty never move).
    //
    // Anchored on left_leg (select it FIRST, hierarchy-as-assignment — unlike this
    // file's own `placeChain` helper, which deliberately clears selection for a
    // free-form root): node mode's `chainBonesOfPart` only draws bones actually
    // PARENTED under the edited part, so the chain must really hang off left_leg for
    // its marker (and glyph) to appear there at all.
    modelSelectPart(partByLabel('left_leg').id);
    notify();
    repaint();
    const [b1] = placeBoneChain(medialPoints('left_leg', 2));
    enterNodeMode('left_leg'); // selects left_leg, state.mode = 'nodes', editorMode stays 'setup'
    pressKey('y'); // freeze ON
    repaint();
    expect(state.freezeMode).toBe(true);
    expect(state.mode).toBe('nodes');
    expect(state.selectedPartId, 'left_leg (not the bone) is the node-edited part').not.toBe(b1.id);

    // MUTATION-CHECK NOTE: before the fix, no data-role="pivot" element exists for the
    // unselected bone while node-editing — this querySelector finds nothing, and the
    // press instead lands on the bone glyph / the edited outline (bend) or empty space
    // (marquee), leaving the bone's own fields untouched either way.
    const marker = overlayEl().querySelector(`[data-role="pivot"][data-part-id="${b1.id}"]`);
    expect(marker, 'a freeze-mode origin marker exists for the unselected bone even in node-editing mode')
      .toBeTruthy();
    const from = clientCenterOf(marker!);
    const pivot0 = { ...b1.pivot };
    const leftLeg = partByLabel('left_leg');
    const dBefore = leftLeg.paths.map((p) => p.d);

    gestureDrag(from, { x: from.x + 34, y: from.y - 26 }, { steps: 10 });

    const cur = state.doc!.parts.find((p) => p.id === b1.id)!;
    const legAfter = partByLabel('left_leg');
    expect(state.selectedPartId, 'the press selected the bone in the SAME gesture').toBe(b1.id);
    const moved = Math.hypot(cur.pivot.x - pivot0.x, cur.pivot.y - pivot0.y);
    expect(moved, 'the joint (pivot) actually moved').toBeGreaterThan(0.3);
    expect(legAfter.paths.map((p) => p.d), 'the outline geometry was never bent')
      .toEqual(dBefore);
  });
});
