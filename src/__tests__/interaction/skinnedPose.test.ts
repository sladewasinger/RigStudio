/**
 * Interaction tests for the skinned-part posing ruling (user 2026-07-12, "Allow
 * rotate+translate" — CLAUDE.md "Skinned-part UX", ROADMAP.md "Skinned-part posing
 * decision"): a skinned part's bones are parented under it, so its rotate/tx/ty
 * genuinely carry the whole chain — the LBS-deformed art follows exactly like .riv
 * playback — so body drags for those two channels now behave EXACTLY like any other
 * part's. Scale/skew stay blocked (never propagate to a part's children in the editor,
 * unlike a Rive Node at runtime), both on canvas (no handles render — overlayHandles.ts)
 * and in the inspector (fields disabled — transformSection.ts). IK stays its own entry
 * gesture, unaffected (still pinned by ikDrag.ts's scenario IK4 and bones.test.ts's B10).
 * Full realistic gestures via the harness (elementFromPoint hit targets, real drag
 * sequences) — see "Testing interactions" in CLAUDE.md.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { selectPart as modelSelectPart, notify } from '../../core/model';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, gestureDrag, click,
  clientPointOnPart, overlayCount, expectClose, setEditorMode, medialPoints, clipTrack,
  placeBoneChain, selectByLabel,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/**
 * THE CONNECTED-CHAIN INVARIANT (copied from bones.test.ts / freeze.test.ts): a child
 * bone's origin never drifts from its parent's tip, in either mode, after any gesture —
 * the bones ride the skinned part's own pose by construction, so a rotate/translate drag
 * on the part must never open a gap. Enforced after EVERY scenario in this file.
 */
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

const LIMB = 'left_leg';

/**
 * Bind a 2-bone chain down LIMB's medial axis with LIMB SELECTED first, so bone 1
 * PARENTS to it (hierarchy-as-assignment: LIMB → bone1 → bone2 — CLAUDE.md "Bones stay
 * PARENTED under the art"). This is the precondition the whole ruling rests on: a
 * FREE-FORM root bone (nothing selected when the chain starts) binds by geometric
 * coverage alone and is NOT an ancestor of the part it deforms, so rotating that part
 * would correctly do nothing to its bones — mirrors bones.test.ts's `placeParentedChain`.
 */
function skinLimb() {
  selectByLabel(LIMB);
  const bones = placeBoneChain(medialPoints(LIMB, 2));
  expect(partByLabel(LIMB).skin, 'limb auto-bound').toBeTruthy();
  expect(bones[0].parentId, 'bone 1 parented to the limb').toBe(partByLabel(LIMB).id);
  return bones;
}

/** Concatenated rendered `d` of a part's path elements (the LBS-deformed geometry). */
function renderedD(label: string): string {
  return Array.from(partGroupEl(label).querySelectorAll('path'))
    .map((p) => p.getAttribute('d') ?? '').join('|');
}

function fieldInput(label: string): HTMLInputElement | null {
  const field = Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'))
    .find((f) => f.querySelector('span')?.textContent === label);
  return (field?.querySelector('input') as HTMLInputElement) ?? null;
}

describe('scenario SP1 — Animate rotate-mode body-drag on a skinned part keys rotate and deforms the art', () => {
  it('the second click enters rotate mode; dragging writes a rotate key and the whole limb visibly swings', () => {
    const [b1, b2] = skinLimb();
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel(LIMB).id;
    const b1Rot0 = b1.rest.rotate;

    let pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y); // select → translate/scale set (the default first-click state)
    pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y); // motionless click on the primary toggles to rotate mode

    const artBefore = renderedD(LIMB);
    const b1TransformBefore = partGroupEl(b1.label).getAttribute('transform');
    pt = clientPointOnPart(LIMB);
    gestureDrag(pt, { x: pt.x + 35, y: pt.y - 25 });
    const b1TransformAfter = partGroupEl(b1.label).getAttribute('transform');

    const track = clipTrack(id, 'rotate');
    expect(track, 'rotate track created on the skinned part itself (not a bone)').toBeTruthy();
    expect(track!.keyframes[0].time).toBe(0);
    expect(clipTrack(id, 'tx'), 'no tx track from a plain rotate drag').toBeFalsy();
    // The bones are parented under the skinned part, so its OWN rest never moves under a
    // keyed rotate — the whole chain instead rides the composed CHAIN matrix. Prove the
    // bones actually swung (not just that a key exists) by asserting the bone's own
    // rendered transform (its ancestor chain, which includes the part's new keyed
    // rotate) changed, and the rendered art followed.
    expect(b1.rest.rotate, 'bone rest stays untouched — only the part chain matrix moved').toBe(b1Rot0);
    expect(b1TransformAfter, 'bone 1 rendered transform moved — the chain matrix picked up the new key')
      .not.toBe(b1TransformBefore);
    expect(renderedD(LIMB), 'the LBS-deformed art visibly followed the rotate').not.toBe(artBefore);
    void b2;
  });
});

describe('scenario SP2 — Shift+drag TRANSLATES a skinned part, keys tx/ty, and deforms the art', () => {
  it('a Shift+drag on the skinned art keys tx/ty (not rotate) and the rendered art follows', () => {
    skinLimb();
    setEditorMode('animate');
    state.currentTime = 0;
    const id = partByLabel(LIMB).id;

    const artBefore = renderedD(LIMB);
    const pt = clientPointOnPart(LIMB);
    gestureDrag(pt, { x: pt.x + 28, y: pt.y + 18 }, { shiftKey: true });

    expect(clipTrack(id, 'tx'), 'tx track created').toBeTruthy();
    expect(clipTrack(id, 'ty'), 'ty track created').toBeTruthy();
    expect(clipTrack(id, 'rotate'), 'no rotate track from a Shift-drag').toBeFalsy();
    expect(renderedD(LIMB), 'the LBS-deformed art visibly followed the translate').not.toBe(artBefore);
  });
});

describe('scenario SP3 — handle-set toggle on a skinned part: scale/skew stay off, rotate corners go live', () => {
  it('Edit mode: first click has 0 scale handles (passive corners only); second click has 4 ACTIVE rotate corners and 0 skew', () => {
    skinLimb();
    setEditorMode('setup');

    let pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y); // select → scale/translate mode (default)
    expect(overlayCount('.scale-handle'), 'scale is blocked on a skinned part').toBe(0);
    expect(overlayCount('.select-corner'), 'passive translate corners show instead').toBe(4);

    pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y); // toggle to rotate mode
    expect(overlayCount('.rotate-handle'), '4 ACTIVE rotate corners — rotate now carries the bone chain').toBe(4);
    expect(overlayCount('.skew-handle'), 'skew stays blocked on a skinned part').toBe(0);
  });

  it('Animate mode: the second click also shows the 4 active rotate corners (parity with Edit)', () => {
    skinLimb();
    setEditorMode('animate');

    let pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y);
    expect(overlayCount('.rotate-handle'), 'no rotate handles on the first (translate) click').toBe(0);
    pt = clientPointOnPart(LIMB);
    click(pt.x, pt.y);
    expect(overlayCount('.rotate-handle'), '4 rotate handles visible on the second click').toBe(4);
    expect(overlayCount('.skew-handle'), 'skew has no keyable channel in Animate').toBe(0);
  });
});

describe('scenario SP4 — inspector locks scale/skew on a skinned part; rotate/translate stay live', () => {
  it('Edit mode: rest scale x/y and skew x/y are disabled with a title; rotate/x/y stay live', () => {
    skinLimb();
    setEditorMode('setup');
    modelSelectPart(partByLabel(LIMB).id);
    notify();

    for (const label of ['rest scale x', 'rest scale y', 'skew x (deg)', 'skew y (deg)']) {
      const input = fieldInput(label);
      expect(input, `${label} field present`).toBeTruthy();
      expect(input!.disabled, `${label} disabled on a skinned part`).toBe(true);
      expect(input!.title.length, `${label} carries an explanatory title`).toBeGreaterThan(0);
    }
    for (const label of ['rest rotate (deg)', 'rest x', 'rest y']) {
      const input = fieldInput(label);
      expect(input, `${label} field present`).toBeTruthy();
      expect(input!.disabled, `${label} stays live`).toBe(false);
    }
  });

  it('Animate mode: keyed scale x/y are disabled with a title; rotate/translate x/y stay live', () => {
    skinLimb();
    setEditorMode('animate');
    modelSelectPart(partByLabel(LIMB).id);
    notify();

    for (const label of ['scale x', 'scale y']) {
      const input = fieldInput(label);
      expect(input, `${label} field present`).toBeTruthy();
      expect(input!.disabled, `${label} disabled on a skinned part`).toBe(true);
      expect(input!.title.length, `${label} carries an explanatory title`).toBeGreaterThan(0);
    }
    for (const label of ['rotate (deg)', 'translate x', 'translate y']) {
      const input = fieldInput(label);
      expect(input, `${label} field present`).toBeTruthy();
      expect(input!.disabled, `${label} stays live`).toBe(false);
    }
  });
});
