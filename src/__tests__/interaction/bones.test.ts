/**
 * Interaction tests for Bones 2.0 (P4, then the "broken in real use" overhaul):
 * auto-bind TARGETING (only the right art, geometrically), RENDER-NEUTRAL bind, child
 * bones as connected joints, skinned-part UX (fresh overlay + no lying handles), IK on
 * the skinned art, and per-node overrides. Full realistic gestures via the harness
 * (elementFromPoint hit targets, intermediate pointermoves, real overlay handles).
 *
 * RE-SPEC NOTE: bones are now placed down each limb's MEDIAL axis (`medialPoints`) not
 * its bounding-box centre line. The old `axisPoints` walked the bbox centre, which
 * grazes a diagonal/offset limb's edge (Pip's legs widen at the foot). The old bbox
 * auto-bind bound anything the bone's box brushed, so that mis-placement "worked"; the
 * new geometric fill-sample auto-bind (correctly) refuses a bone that misses the fill,
 * so tests must place bones where a user actually would — on the visible limb.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import {
  selectPart as modelSelectPart, setKeyframe, notify,
  serializeDoc, deserializeDoc,
} from '../../core/model';
import {
  startBonePlacement, renderPose, setNodeBinding, recomputeAutoWeights, resetView,
  unbindSelectedSkin,
} from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, gestureDrag, click, moveMouse,
  clientCenterOf, overlayEl, overlayCount, expectClose, setEditorMode, repaint,
  enterNodeMode, medialPoints, clientPointOnPart, svgEl, selectByLabel, pressKey, hitAt,
  rootGEl, pathElById, assertScreenConstant, waitFor, clipTrack, placeBoneChain, fullDblClick,
  loadFixtureSvg,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/**
 * THE CONNECTED-CHAIN INVARIANT (v2.13 bone rework): a child bone's origin IS its parent
 * bone's tip — one shared joint that NEVER opens a gap, in either mode, after any gesture.
 * In the bone position model a child keeps zero rest translate, so its origin equals its
 * parent's tip in the parent's frame. Enforced after EVERY scenario in this file.
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

/** Place a single bone by the pen-tool chain (origin click → tip click); returns the bone. */
function placeBoneGesture(from: { x: number; y: number }, to: { x: number; y: number }) {
  return placeBoneChain([from, to])[0];
}

/**
 * Place an n-bone chain down a limb's MEDIAL axis with the pen tool, nothing selected (so
 * bone 1 is a free-form root → geometric auto-bind). N+1 medial click points → N bones,
 * each committed at its click and connected to the previous joint (the click-click model
 * makes the shared joint automatic — no per-bone offset press needed any more).
 */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  modelSelectPart(null);
  notify();
  renderPose();
  return placeBoneChain(medialPoints(label, n));
}

/** Concatenated rendered `d` of a part's path elements (the LBS-deformed geometry). */
function renderedD(label: string): string {
  return Array.from(partGroupEl(label).querySelectorAll('path'))
    .map((p) => p.getAttribute('d') ?? '').join('|');
}

/** The model rest `d` of a part's paths (must stay byte-identical under LBS). */
function modelD(label: string): string {
  return partByLabel(label).paths.map((p) => p.d).join('|');
}

/**
 * Every path point of a part sampled at 0,0.1,…,1.0 of its length, in CLIENT px — the
 * RENDERED geometry, independent of local↔root baking (which trivially changes the raw
 * `d` string). A render-neutral bind must leave these byte-stable.
 */
function renderScreenSamples(label: string): number[] {
  const g = partGroupEl(label);
  const svg = svgEl();
  const out: number[] = [];
  for (const pe of Array.from(g.querySelectorAll('path')) as SVGPathElement[]) {
    const len = pe.getTotalLength();
    if (!(len > 0)) continue;
    const m = pe.getScreenCTM()!;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const q = pe.getPointAtLength(len * f);
      const pt = svg.createSVGPoint(); pt.x = q.x; pt.y = q.y;
      const s = pt.matrixTransform(m);
      out.push(s.x, s.y);
    }
  }
  return out;
}

function maxDrift(a: number[], b: number[]): number {
  let mx = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
  return mx;
}

const LIMB = 'left_leg';

describe('scenario B1 — auto-bind targets ONLY the limb under the chain + LBS bend', () => {
  it('a medial 3-bone chain skins the limb (not its neighbours); the middle bone bends the render, rest d byte-identical', () => {
    expect(partByLabel(LIMB).skin ?? null).toBeNull();

    const [, mid] = placeChain(LIMB, 3);

    const skin = partByLabel(LIMB).skin;
    expect(skin, 'limb auto-bound').toBeTruthy();
    expect(skin!.bones.length, 'bound to all 3 chain bones').toBe(3);
    // The geometric test must NOT skin neighbours the old bbox test grabbed (the shadow
    // ellipse under the feet, the other leg).
    expect(partByLabel('shadow').skin ?? null, 'shadow not bound').toBeNull();
    expect(partByLabel('right_leg').skin ?? null, 'other leg not bound').toBeNull();

    const restD = modelD(LIMB);
    const before = renderedD(LIMB);

    setEditorMode('animate');
    state.currentTime = 0;
    setKeyframe(mid.id, 'rotate', 40);
    repaint();

    expect(renderedD(LIMB), 'rendered path bends').not.toBe(before);
    expect(modelD(LIMB), 'rest path.d stays byte-identical (LBS never mutates it)').toBe(restD);
  });
});

describe('scenario B2 — placement + binding is ONE undo', () => {
  it('one undo reverts a freshly placed bone AND the binding it created', () => {
    const before = state.doc!.parts.length;
    expect(partByLabel(LIMB).skin ?? null).toBeNull();

    placeChain(LIMB, 1);

    expect(state.doc!.parts.length).toBe(before + 1);
    expect(partByLabel(LIMB).skin, 'bound by the placement').toBeTruthy();

    expect(canUndo()).toBe(true);
    undo();

    expect(state.doc!.parts.length, 'bone removed').toBe(before);
    expect(partByLabel(LIMB).skin ?? null, 'binding reverted in the same step').toBeNull();
  });
});

describe('scenario B3 — child bone anchors at the parent tip (connected joint)', () => {
  it('a child bone origin lands exactly on the parent bone tip', () => {
    const [b1, b2] = placeChain(LIMB, 2);
    expect(b2.parentId, 'child parented to the bone').toBe(b1.id);
    expectClose(b2.pivot.x, b1.boneTip!.x, 0.3, 'child origin x == parent tip x');
    expectClose(b2.pivot.y, b1.boneTip!.y, 0.3, 'child origin y == parent tip y');
  });
});

describe('scenario B4 — full-chain IK through the bound chain (grab the tip bone glyph)', () => {
  it('IK-dragging the chain end rotates EVERY joint incl. the grabbed bone, and deforms the art', () => {
    // RE-SPEC (full-chain FABRIK): the old analytic solver rotated exactly the grabbed
    // bone's two nearest ancestors and left the grabbed bone itself rigid. FABRIK rotates
    // the whole chain root→grabbed — so b3 (grabbed) must ALSO change, not just b1/b2.
    const [b1, b2, b3] = placeChain(LIMB, 3);
    expect(partByLabel(LIMB).skin!.bones.length).toBe(3);

    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const glyph = overlayEl().querySelector(`[data-part-id="${b3.id}"]`);
    expect(glyph, 'end-bone glyph present').toBeTruthy();
    const from = clientCenterOf(glyph!);

    const rot1Before = b1.rest.rotate;
    const rot2Before = b2.rest.rotate;
    const rot3Before = b3.rest.rotate;
    const artBefore = renderedD(LIMB);

    const root = clientCenterOf(overlayEl().querySelector(`[data-part-id="${b1.id}"]`)!);
    const dxr = root.x - from.x, dyr = root.y - from.y;
    const len = Math.hypot(dxr, dyr) || 1;
    const toward = {
      x: from.x + dxr * 0.65 + (-dyr / len) * 35,
      y: from.y + dyr * 0.65 + (dxr / len) * 35,
    };
    gestureDrag(from, toward, { steps: 12 });

    const b1After = state.doc!.parts.find((p) => p.id === b1.id)!;
    const b2After = state.doc!.parts.find((p) => p.id === b2.id)!;
    const b3After = state.doc!.parts.find((p) => p.id === b3.id)!;
    expect(Math.abs(b1After.rest.rotate - rot1Before), 'root joint rotated').toBeGreaterThan(0.5);
    expect(Math.abs(b2After.rest.rotate - rot2Before), 'mid joint rotated').toBeGreaterThan(0.5);
    expect(Math.abs(b3After.rest.rotate - rot3Before), 'grabbed bone itself rotated (the fix)')
      .toBeGreaterThan(0.5);
    expect(renderedD(LIMB), 'skinned art deformed under IK').not.toBe(artBefore);
  });
});

describe('scenario B5 — per-node weight overrides', () => {
  it('pinning selected nodes to a bone changes the deformation and survives a round-trip', () => {
    const bones = placeChain(LIMB, 3);
    const end = bones[bones.length - 1];

    enterNodeMode(LIMB);
    const handles = Array.from(
      overlayEl().querySelectorAll('.node-handle[data-field="x"]'),
    ) as SVGElement[];
    expect(handles.length, 'node handles present on the skinned part').toBeGreaterThan(2);
    const a = clientCenterOf(handles[0]);
    const b = clientCenterOf(handles[Math.floor(handles.length / 2)]);
    click(a.x, a.y);
    click(b.x, b.y, { shiftKey: true });

    // Leave node-editing scope before measuring the render: node editing SUSPENDS LBS
    // deformation on its target part (v2.13 follow-up — handles must sit on the
    // undeformed art, see scenario B17), so the rendered `d` while still in node mode
    // would be the rigid rest shape regardless of bone rotation or overrides. Node
    // selection survives the mode flip (setNodeBinding reads it directly), so this is
    // still the exact override the handle clicks above selected.
    state.mode = 'rig';

    const endBone = state.doc!.parts.find((p) => p.id === end.id)!;
    endBone.rest.rotate = 55;
    repaint();
    const autoD = renderedD(LIMB);

    expect(setNodeBinding(end.id, null, 1)).toBe(true);
    repaint();

    const skin = partByLabel(LIMB).skin!;
    expect(skin.overrides, 'override recorded on the part').toBeTruthy();
    const total = Object.values(skin.overrides!).reduce((s, rec) => s + Object.keys(rec).length, 0);
    expect(total, 'both selected nodes pinned').toBeGreaterThanOrEqual(2);
    expect(renderedD(LIMB), 'override changes the deformation').not.toBe(autoD);

    const round = deserializeDoc(serializeDoc(state.doc!));
    const limbBack = round.parts.find((p) => p.label === LIMB)!;
    expect(limbBack.skin!.overrides).toEqual(skin.overrides);
  });
});

describe("scenario B6 — the user's exact repro: arm bone must NOT drag in the body", () => {
  it('selecting right_arm and placing a shoulder→wrist bone skins ONLY right_arm', () => {
    // The reported bug: right_arm selected, a bone near shoulder→wrist, and the BODY
    // got skinned (and rotated) too — the old bbox test bound anything the joint grazed,
    // and the shoulder pivot sits inside the body's bounding box.
    selectByLabel('right_arm');
    const pts = medialPoints('right_arm', 1);
    placeBoneGesture(pts[0], pts[1]);

    expect(partByLabel('right_arm').skin, 'right_arm skinned').toBeTruthy();
    expect(partByLabel('body').skin ?? null, 'body must NOT be skinned').toBeNull();
    expect(partByLabel('shadow').skin ?? null, 'shadow must NOT be skinned').toBeNull();
    const skinned = state.doc!.parts.filter((p) => p.skin).map((p) => p.label);
    expect(skinned, 'exactly one part skinned').toEqual(['right_arm']);
  });
});

describe('scenario B7 — bind is RENDER-NEUTRAL (art must not move a pixel)', () => {
  it('binding a part whose paths carry a transform leaves the rendered geometry byte-stable', () => {
    // right_arm's paths carry `rotate(45,…)` — the config that made bind visibly shift
    // the art (the baked geometry double-applied the stale DOM transform). left_leg,
    // which the old tests used, has NO path transform, so it never caught this.
    selectByLabel('right_arm');
    const before = renderScreenSamples('right_arm');
    const pts = medialPoints('right_arm', 1);
    placeBoneGesture(pts[0], pts[1]);
    repaint();

    expect(partByLabel('right_arm').skin, 'bound').toBeTruthy();
    expectClose(maxDrift(before, renderScreenSamples('right_arm')), 0, 0.05,
      'rendered geometry stable across bind');
  });

  it('binding a part with a non-identity REST (rotate 40.6°) is also render-neutral', () => {
    // The bug the redesign called out: the bone rode the art's rest rotate, bind baked
    // that rotate into the geometry AND zeroed it on the art, so the LBS rest delta
    // un-did it and shifted the art. (The user's saved file had left_arm at rest.rotate
    // 40.6; the fresh import bakes that into part.transform, so impose one explicitly.)
    // A pure rotation keeps getPointAtLength's arc-length fractions stable, so the sampled
    // render points stay a valid before/after comparison.
    const leg = partByLabel('right_leg');
    modelSelectPart(leg.id);
    leg.rest.rotate = 40.6;
    notify();
    renderPose();
    const before = renderScreenSamples('right_leg');
    const pts = medialPoints('right_leg', 1);
    placeBoneGesture(pts[0], pts[1]);
    repaint();

    expect(partByLabel('right_leg').skin, 'bound').toBeTruthy();
    expectClose(maxDrift(before, renderScreenSamples('right_leg')), 0, 0.05,
      'rest-rotated art stable across bind');
  });
});

describe('scenario B8 — skinned-part overlay is fresh + explains itself', () => {
  it('clicking a skinned part shows a selection box + hint immediately, with NO lying handles', () => {
    placeChain(LIMB, 2);
    expect(partByLabel(LIMB).skin, 'limb skinned').toBeTruthy();

    // Click the skinned art with the select tool (a real hit-target click). The bug:
    // the overlay stayed stale (no box) until a pan/zoom forced a repaint, because a
    // skinned part starts no drag, so pointerup's end() never repainted.
    state.tool = 'select';
    const p = clientPointOnPart(LIMB);
    click(p.x, p.y);

    expect(state.selectedPartId, 'skinned part selected').toBe(partByLabel(LIMB).id);
    expect(overlayCount('.select-box'), 'selection box present WITHOUT a pan/zoom').toBeGreaterThan(0);
    expect(overlayCount('.skin-hint'), 'a "skinned — pose with its bones" hint is shown').toBe(1);
    expect(overlayCount('.scale-handle'), 'no scale handles (they would be lies)').toBe(0);
    expect(overlayCount('.rotate-handle'), 'no rotate handles').toBe(0);
  });
});

describe('scenario B9 — connected chain: the shared joint moves as one', () => {
  // RE-SPEC (v2.13 bone rework): a child bone's origin and its parent's tip are the SAME
  // shared joint, now LIVE in both modes (dragging it moves the joint + deforms the art
  // outside freeze). This scenario runs in freeze to isolate the shared-joint COUPLING (the
  // parent tip / child origin tracking each other) from art deformation; the coupling holds
  // identically without freeze.
  it('dragging a child bone pivot carries the parent tip, and vice-versa', () => {
    const [b1, b2] = placeChain(LIMB, 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    pressKey('y'); // freeze mode: unlock origin/joint editing for this scenario

    // Drag the CHILD's pivot handle — the parent tip must follow (one shared joint).
    state.tool = 'select';
    modelSelectPart(b2.id);
    repaint();
    const pivot = overlayEl().querySelector('.pivot-grab');
    expect(pivot, 'child pivot handle present').toBeTruthy();
    const p0 = { ...cur(b2.id).pivot };
    const t0 = { ...cur(b1.id).boneTip! };
    const from = clientCenterOf(pivot!);
    gestureDrag(from, { x: from.x + 30, y: from.y + 22 });
    const childMoved = Math.hypot(cur(b2.id).pivot.x - p0.x, cur(b2.id).pivot.y - p0.y);
    expect(childMoved, 'child pivot actually moved').toBeGreaterThan(0.3);
    expectClose(cur(b1.id).boneTip!.x, cur(b2.id).pivot.x, 0.2, 'parent tip x tracked the joint');
    expectClose(cur(b1.id).boneTip!.y, cur(b2.id).pivot.y, 0.2, 'parent tip y tracked the joint');
    void t0;

    // Drag the PARENT's tip handle — the child origin must follow.
    modelSelectPart(b1.id);
    repaint();
    const tip = overlayEl().querySelector('.bone-tip-handle');
    expect(tip, 'parent tip handle present + on top (not occluded by child glyph)').toBeTruthy();
    const tp0 = { ...cur(b1.id).boneTip! };
    const tfrom = clientCenterOf(tip!);
    gestureDrag(tfrom, { x: tfrom.x - 26, y: tfrom.y - 20 });
    const tipMoved = Math.hypot(cur(b1.id).boneTip!.x - tp0.x, cur(b1.id).boneTip!.y - tp0.y);
    expect(tipMoved, 'parent tip actually moved').toBeGreaterThan(0.3);
    expectClose(cur(b2.id).pivot.x, cur(b1.id).boneTip!.x, 0.2, 'child origin x tracked the joint');
    expectClose(cur(b2.id).pivot.y, cur(b1.id).boneTip!.y, 0.2, 'child origin y tracked the joint');
  });
});

describe('scenario B10 — IK on the SKINNED ART bends the chain', () => {
  it('with the IK tool, dragging the skinned art rotates its bones and deforms it', () => {
    const [b1, b2] = placeChain(LIMB, 2);
    expect(partByLabel(LIMB).skin, 'limb skinned').toBeTruthy();

    // The reported bug: IK did nothing. Skinned parts were gated out of ALL pose drags,
    // so an IK press on the art fell through inert.
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    const r1 = b1.rest.rotate, r2 = b2.rest.rotate;
    const artBefore = renderedD(LIMB);

    const grab = clientPointOnPart(LIMB);
    gestureDrag(grab, { x: grab.x - 30, y: grab.y - 40 }, { steps: 12 });

    // RE-SPEC (full-chain FABRIK): the skinned-art IK path solves the whole bone chain, so
    // BOTH joints participate (the old two-joint solver would still move both here, but on
    // a 3+ chain it capped at two — the 4-bone scenario B23 is the mutation-check for that).
    expect(Math.abs(cur(b1.id).rest.rotate - r1), 'root joint rotated').toBeGreaterThan(0.5);
    expect(Math.abs(cur(b2.id).rest.rotate - r2), 'tip joint rotated').toBeGreaterThan(0.5);
    expect(renderedD(LIMB), 'skinned art deformed under IK').not.toBe(artBefore);
  });
});

describe('scenario B12 — bone position model: length edit propagates the chain', () => {
  function fieldInput(label: string): HTMLInputElement | null {
    const field = Array.from(document.querySelectorAll<HTMLLabelElement>('#inspector label.field'))
      .find((f) => f.querySelector('span')?.textContent === label);
    return (field?.querySelector('input') as HTMLInputElement) ?? null;
  }

  it('editing a ROOT bone length moves its tip and carries the child origin (shared joint)', () => {
    const [b1, b2] = placeChain(LIMB, 2);
    modelSelectPart(b1.id); // b1 is a root bone (placed free-form)
    notify();
    renderPose();

    const len0 = Math.hypot(b1.boneTip!.x - b1.pivot.x, b1.boneTip!.y - b1.pivot.y);
    const target = len0 + 25;
    const input = fieldInput('length');
    expect(input, 'root bone inspector shows a length field').toBeTruthy();
    input!.value = String(target);
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    const nb1 = cur(b1.id), nb2 = cur(b2.id);
    const newLen = Math.hypot(nb1.boneTip!.x - nb1.pivot.x, nb1.boneTip!.y - nb1.pivot.y);
    expectClose(newLen, target, 0.01, 'root bone length updated');
    expectClose(nb2.pivot.x, nb1.boneTip!.x, 0.01, 'child origin x tracks the extended tip');
    expectClose(nb2.pivot.y, nb1.boneTip!.y, 0.01, 'child origin y tracks the extended tip');
  });

  it('a CHILD bone inspector shows rotation + length but NO position / raw pivot / rest fields', () => {
    const [, b2] = placeChain(LIMB, 2);
    modelSelectPart(b2.id); // b2 is a child bone (parented to b1)
    notify();
    renderPose();
    const labels = Array.from(
      document.querySelectorAll<HTMLLabelElement>('#inspector label.field span'),
    ).map((s) => s.textContent);
    expect(labels, 'rotation field present').toContain('rotation (deg)');
    expect(labels, 'length field present').toContain('length');
    expect(labels, 'no independent position on a child').not.toContain('position x');
    expect(labels, 'no raw pivot field on a child').not.toContain('pivot x');
    expect(labels, 'no raw rest-translate field on a child').not.toContain('rest x');
  });
});

describe('scenario B11 — recompute auto weights is enabled whenever skinned', () => {
  it('the button is enabled for a skinned part and dropping overrides recomputes', () => {
    placeChain(LIMB, 2);
    selectByLabel(LIMB);

    const recompute = Array.from(document.querySelectorAll<HTMLButtonElement>('#inspector button'))
      .find((b) => /recompute auto weights/.test(b.textContent ?? ''));
    expect(recompute, 'recompute button present').toBeTruthy();
    expect(recompute!.disabled, 'enabled whenever the part is skinned (was always grayed)').toBe(false);

    // Add an override, then recompute drops it (returns true = doc changed).
    const skin = partByLabel(LIMB).skin!;
    const pathId = partByLabel(LIMB).paths[0].id;
    skin.overrides = { [pathId]: { '1': { a: skin.bones[0].id, b: null, t: 1 } } };
    expect(recomputeAutoWeights(), 'recompute drops the override').toBe(true);
    expect(partByLabel(LIMB).skin!.overrides, 'overrides cleared').toBeUndefined();
    // With no overrides it still recomputes (cache rebuild) but reports no doc change.
    expect(recomputeAutoWeights(), 'no-op recompute reports no change').toBe(false);
  });
});

// ---- v2.13 bone rework: hierarchy-as-assignment, no free child translation, the
// freeze / non-freeze pose matrix ----

/** pivot→tip length of a bone in its own frame. */
function boneLen(b: ReturnType<typeof partByLabel>): number {
  return b.boneTip ? Math.hypot(b.boneTip.x - b.pivot.x, b.boneTip.y - b.pivot.y) : 0;
}

/**
 * A bone's TIP in CLIENT px, from its own rendered (if hidden) group's LIVE screen CTM
 * — never a captured element/rect. Needed since Post-A Fix 2 (grab-point-relative IK):
 * `clientCenterOf(a bone's glyph)` is only ever an approximate MIDPOINT of the kite
 * polygon, not the tip, so a scenario that means to grab the tip precisely (not "grab
 * somewhere on the bone and see the whole chain move") must compute it directly.
 */
function boneTipClient(b: ReturnType<typeof partByLabel>): { x: number; y: number } {
  const g = svgEl().querySelector<SVGGElement>(`[data-part-id="${b.id}"]`)!;
  const m = g.getScreenCTM()!;
  const pt = svgEl().createSVGPoint();
  pt.x = b.boneTip!.x; pt.y = b.boneTip!.y;
  const s = pt.matrixTransform(m);
  return { x: s.x, y: s.y };
}

/**
 * Place an n-bone chain with the ART part SELECTED first, so bone 1 PARENTS to the art
 * (the locked hierarchy-as-assignment chain art→bone1→…→bone n) and every bone binds it.
 * Selection is preserved across the chain's clicks, so the single auto-bind at the end
 * targets the selected art (targeting rule #2).
 */
function placeParentedChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  selectByLabel(label); // art selected → bone 1 parents to it and auto-bind targets it
  return placeBoneChain(medialPoints(label, n));
}

describe('scenario B13 — chain stays PARENTED under the art (hierarchy-as-assignment)', () => {
  it('a chain placed on a selected, rest-rotated art shows art→bone1→bone2 in the doc, render-neutral', () => {
    // The d1c26b5 regression: bind re-parented the chain to root to preserve the bone world,
    // detaching it from the art in the layers tree. The fix folds the lost art pose into the
    // bone's OWN rest while KEEPING parentId == the art, so the tree still reads art→bones.
    const arm = partByLabel('left_arm');
    modelSelectPart(arm.id);
    arm.rest.rotate = 30; // a real rest for the bone to ride + the fold to undo
    notify();
    renderPose();
    const before = renderScreenSamples('left_arm');

    const [b1, b2] = placeParentedChain('left_arm', 2);

    // Hierarchy: art → bone1 → bone2 (the locked assignment chain).
    expect(partByLabel('left_arm').skin, 'art skinned by the chain').toBeTruthy();
    expect(b1.parentId, 'bone 1 stays parented to the art (NOT re-homed to root)').toBe(arm.id);
    expect(b2.parentId, 'bone 2 parented to bone 1').toBe(b1.id);
    expect(partByLabel('left_arm').skin!.bones.map((b) => b.id))
      .toEqual([b1.id, b2.id]);

    // Render-neutral: the rest-rotated art did not move a pixel across placement + bind.
    expectClose(maxDrift(before, renderScreenSamples('left_arm')), 0, 0.06,
      'rest-rotated art stable across bind, parented');
  });
});

describe('scenario B14 — a child bone has NO free translation; a body drag rotates it', () => {
  it('the translate tool cannot slide a child bone (origin byte-stable, no gap); a select drag rotates it about the joint', () => {
    const [b1, b2] = placeParentedChain('left_leg', 2);
    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    const origin0 = { ...cur(b2.id).pivot };
    const tip0 = { ...cur(b1.id).boneTip! };

    // (1) Translate tool: grab the X-axis arrow of the translate gizmo and pull hard. A bone
    // is filtered out of every translate pipeline, so this is a no-op — the shared joint can
    // NOT slide (bug #2: a body-drag used to translate a child bone and tear open a gap).
    state.tool = 'translate';
    modelSelectPart(b2.id);
    repaint();
    const arrow = overlayEl().querySelector('[data-gizmo-axis="x"]')!;
    const aFrom = clientCenterOf(arrow);
    expect(hitAt(aFrom.x, aFrom.y).getAttribute('data-gizmo-axis'), 'press lands on the X arrow')
      .toBe('x');
    gestureDrag(aFrom, { x: aFrom.x + 60, y: aFrom.y }, { steps: 10 });
    expect(cur(b2.id).pivot, 'child origin byte-stable under a translate drag').toEqual(origin0);
    expect(cur(b1.id).boneTip, 'parent tip byte-stable — no gap').toEqual(tip0);

    // (2) Select tool: a body drag on the bone (its rotate gizmo) rotates it about the origin
    // and deforms the skinned art — the origin (shared joint) still never moves.
    state.tool = 'select';
    modelSelectPart(b2.id);
    repaint();
    const rot0 = cur(b2.id).rest.rotate;
    const artBefore = renderScreenSamples('left_leg');
    const glyph = overlayEl().querySelector(`[data-part-id="${b2.id}"]`)!;
    const from = clientCenterOf(glyph);
    gestureDrag(from, { x: from.x + 34, y: from.y - 26 }, { steps: 10 });
    expect(Math.abs(cur(b2.id).rest.rotate - rot0), 'child bone rotated').toBeGreaterThan(0.5);
    expect(cur(b2.id).pivot, 'origin still byte-stable under rotation (no gap)').toEqual(origin0);
    expect(maxDrift(artBefore, renderScreenSamples('left_leg')), 'art deformed').toBeGreaterThan(0.5);
  });
});

describe('scenario B15 — NON-freeze tip drag rotates + STRETCHES the limb (art follows)', () => {
  it('dragging a leaf tip outward lengthens the bone and deforms the skinned art', () => {
    const [bone] = placeParentedChain('left_leg', 1);
    expect(partByLabel('left_leg').skin, 'limb skinned').toBeTruthy();
    modelSelectPart(bone.id);
    repaint();

    const len0 = boneLen(bone);
    const artBefore = renderScreenSamples('left_leg');

    // Pull the tip straight out along the bone axis (origin → tip), so the drag is mostly a
    // stretch: the bone gets longer AND the art stretches through the LBS length term.
    const originC = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    const dx = tipC.x - originC.x, dy = tipC.y - originC.y;
    const d = Math.hypot(dx, dy) || 1;
    const to = { x: tipC.x + (dx / d) * d * 0.5, y: tipC.y + (dy / d) * d * 0.5 };
    gestureDrag(tipC, to, { steps: 10 });

    const after = state.doc!.parts.find((p) => p.id === bone.id)!;
    expect(boneLen(after) - len0, 'bone stretched (tip pushed out)').toBeGreaterThan(3);
    expect(maxDrift(artBefore, renderScreenSamples('left_leg')), 'skinned art deformed/stretched')
      .toBeGreaterThan(1);
  });
});

describe('scenario B16 — one gesture = one undo (freeze tip reshape + bind refresh)', () => {
  it('a freeze-mode tip reshape is a single history step incl. its bind refresh', () => {
    const [bone] = placeParentedChain('left_leg', 1);
    const before = serializeDoc(state.doc!);

    pressKey('y'); // freeze mode
    modelSelectPart(bone.id);
    repaint();

    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(tipC, { x: tipC.x + 40, y: tipC.y - 24 }, { steps: 10 });
    expect(serializeDoc(state.doc!), 'the reshape mutated the doc').not.toBe(before);

    expect(canUndo()).toBe(true);
    undo();
    expect(serializeDoc(state.doc!), 'ONE undo reverts the reshape AND its bind refresh').toBe(before);
  });
});

// ---- v2.13 follow-ups from live bones testing ----

describe('scenario B17 — node editing on a bound part is coherent (handles == rendered art)', () => {
  it('suspends LBS while node-editing (rendered d == rest data, handle sits on the true outline), resumes exactly on exit', () => {
    const [bone] = placeParentedChain(LIMB, 1);
    modelSelectPart(bone.id);
    bone.rest.rotate = 35; // pose the limb away from its bind/rest look
    repaint();
    const posedD = renderedD(LIMB);
    expect(posedD, 'posing actually deformed the art').not.toBe(modelD(LIMB));

    enterNodeMode(LIMB);
    // Coherence: the rendered geometry is EXACTLY the model's bind/rest data — the same
    // data node ops actually edit — not the posed/deformed look a stray drag used to
    // show only transiently.
    expect(renderedD(LIMB), 'suspended render == bind/rest data').toBe(modelD(LIMB));
    expect(overlayCount('.skin-hint'), 'the "bone deformation paused" hint is shown').toBe(1);

    // Handles sit ON the rendered outline: the first node's handle (cmdIndex 0, the M
    // command) must land on the LIVE rendered path's own start point — a real geometric
    // check against the DOM, not a re-derivation that would pass vacuously even broken.
    const path0 = partByLabel(LIMB).paths[0];
    const handle0 = overlayEl().querySelector(
      `.node-handle[data-path-id="${path0.id}"][data-cmd-index="0"]`,
    ) as SVGElement;
    expect(handle0, 'first node handle present').toBeTruthy();
    const pe = pathElById(path0.id);
    const start = pe.getPointAtLength(0);
    const m = pe.getScreenCTM()!;
    const sp = svgEl().createSVGPoint();
    sp.x = start.x; sp.y = start.y;
    const truePt = sp.matrixTransform(m);
    const handleC = clientCenterOf(handle0);
    expectClose(handleC.x, truePt.x, 1, 'handle sits on the true rendered outline (x)');
    expectClose(handleC.y, truePt.y, 1, 'handle sits on the true rendered outline (y)');

    // Exit node editing → deformation resumes to the EXACT prior (posed) pose.
    state.mode = 'rig';
    repaint();
    expect(renderedD(LIMB), 'deformation resumes to the exact prior pose').toBe(posedD);
  });
});

describe('scenario B18 — bones stay visible + selectable while their own part is node-edited', () => {
  it('the chain bones render undimmed in the overlay; an unrelated part still dims', () => {
    const bones = placeParentedChain(LIMB, 2);
    enterNodeMode(LIMB);

    for (const b of bones) {
      expect(
        overlayEl().querySelector(`[data-part-id="${b.id}"]`),
        `${b.id} glyph drawn in node mode`,
      ).toBeTruthy();
      const g = rootGEl().querySelector(`[data-part-id="${b.id}"]`)!;
      expect(g.classList.contains('dimmed'), `${b.id} not dimmed`).toBe(false);
    }
    const otherG = rootGEl().querySelector(`[data-part-id="${partByLabel('right_arm').id}"]`)!;
    expect(otherG.classList.contains('dimmed'), 'an unrelated part still dims').toBe(true);
  });
});

describe('scenario B19 — canvas chrome stays screen-constant across a zoom sweep (GOTCHA guard)', () => {
  it('a bone glyph, a node handle, and the pivot ring hold their on-screen size from fit to ~8x zoom', () => {
    // Deliberately SHORT (a ~12px client-space press-drag, well under a limb's medial
    // span): the girth formula this guards against mixed doc-space and screen-space
    // terms in a Math.min, which only shows non-constant width for a bone short enough
    // that the doc-space term wins at fit zoom — a full-limb bone (medialPoints) never
    // exercised that branch, so it wouldn't have caught the bug this test is for.
    const origin = clientPointOnPart(LIMB);
    placeBoneGesture(origin, { x: origin.x + 12, y: origin.y + 8 });
    modelSelectPart(null);
    resetView();
    repaint();
    assertScreenConstant('.null-glyph.bone circle');

    resetView();
    enterNodeMode('right_arm');
    assertScreenConstant('.node-handle');

    resetView();
    state.mode = 'rig'; // back to the pose tool — node mode's overlay branch has no pivot ring
    selectByLabel('right_leg');
    assertScreenConstant('.pivot-ring');
  });
});

describe('scenario B20 — IK drag feedback: chain highlight + target line', () => {
  it('highlights the solving chain and draws an effector→pointer line mid-drag, clearing on release', () => {
    const [, , b3] = placeParentedChain(LIMB, 3);
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const glyph = overlayEl().querySelector(`[data-part-id="${b3.id}"]`)!;
    const from = clientCenterOf(glyph);
    let activeCount = 0, lineCount = 0;
    gestureDrag(from, { x: from.x - 40, y: from.y + 30 }, {
      steps: 10,
      beforeUp: () => {
        activeCount = overlayCount('.null-glyph.ik-active');
        lineCount = overlayCount('.ik-target-line');
      },
    });

    expect(activeCount, 'the solving chain (2 ancestors + the grabbed bone) is highlighted mid-drag')
      .toBe(3);
    expect(lineCount, 'a target line is drawn mid-drag').toBe(1);
    expect(overlayCount('.null-glyph.ik-active'), 'highlight cleared on release').toBe(0);
    expect(overlayCount('.ik-target-line'), 'target line cleared on release').toBe(0);
  });
});

describe("scenario B21 — a parent tip reshape preserves the CHILD bone's own length/direction (non-freeze)", () => {
  it('dragging the parent tip carries the child origin without shortening/lengthening the child', () => {
    const [b1, b2] = placeParentedChain(LIMB, 2);
    modelSelectPart(b1.id);
    repaint();

    const tip0 = { ...b1.boneTip! };
    const len0 = boneLen(b2);
    const tipVec0 = { x: b2.boneTip!.x - b2.pivot.x, y: b2.boneTip!.y - b2.pivot.y };

    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    gestureDrag(tipC, { x: tipC.x + 55, y: tipC.y - 40 }, { steps: 10 });

    const b1After = state.doc!.parts.find((p) => p.id === b1.id)!;
    const b2After = state.doc!.parts.find((p) => p.id === b2.id)!;
    const moved = Math.hypot(b1After.boneTip!.x - tip0.x, b1After.boneTip!.y - tip0.y);
    expect(moved, 'the parent tip actually moved substantially').toBeGreaterThan(10);

    expectClose(boneLen(b2After), len0, 0.01, "child bone's own length unchanged");
    expectClose(
      b2After.boneTip!.x - b2After.pivot.x, tipVec0.x, 0.01, 'child local tip vector x unchanged',
    );
    expectClose(
      b2After.boneTip!.y - b2After.pivot.y, tipVec0.y, 0.01, 'child local tip vector y unchanged',
    );
  });
});

describe('scenario B22 — child length preservation recurses down a 3-bone chain', () => {
  it('reshaping the ROOT carries both its child AND grandchild without touching either one\'s own length', () => {
    // This scenario targets the classic single-bone tip-reshape (aimBoneAtTip +
    // carryChildOrigins), which needs a REAL press on the tip-handle circle. Two things
    // can steal that press: the 'select' tool's rotate-gizmo RING is a fixed SCREEN
    // radius around the pivot (independent of bone length — screen-constant chrome), so
    // a short bone segment puts its tip inside the ring's reach; and since Post-A Fix 2,
    // the 'ik' tool now routes a direct tip-handle press through FULL-CHAIN IK instead of
    // the single-bone reshape this test means to exercise (its own dedicated coverage:
    // scenario B24). Using a WIDER medial spread than placeParentedChain's default
    // 0.16–0.84 makes each of the 3 bones longer than the ring's reach, so the 'select'
    // tool (unlike 'ik') can be used here without the press landing on the ring instead.
    selectByLabel(LIMB);
    const [b1, b2, b3] = placeBoneChain(medialPoints(LIMB, 3, 0.04, 0.98));
    state.tool = 'select';
    modelSelectPart(b1.id);
    repaint();

    const len2 = boneLen(b2), len3 = boneLen(b3);
    const vec2 = { x: b2.boneTip!.x - b2.pivot.x, y: b2.boneTip!.y - b2.pivot.y };
    const vec3 = { x: b3.boneTip!.x - b3.pivot.x, y: b3.boneTip!.y - b3.pivot.y };

    // Pull straight out along the root's OWN axis (like scenario B15) so the drag is
    // mostly a LENGTH change, not just a rotation — the carried delta this exercises is
    // (new tip local coord − old tip local coord), which stays small for a
    // mostly-rotational drag even when the carry is broken (the bug is a length
    // mismatch, not an angle one); a deliberate stretch makes it unmissable.
    const originC = clientCenterOf(overlayEl().querySelector('.pivot-grab')!);
    const tipC = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    const dx = tipC.x - originC.x, dy = tipC.y - originC.y;
    const d = Math.hypot(dx, dy) || 1;
    const to = { x: tipC.x + (dx / d) * d * 0.6, y: tipC.y + (dy / d) * d * 0.6 };
    gestureDrag(tipC, to, { steps: 10 });

    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    expectClose(boneLen(cur(b2.id)), len2, 0.01, 'grandparent reshape leaves the child length unchanged');
    expectClose(boneLen(cur(b3.id)), len3, 0.01, 'grandparent reshape leaves the grandchild length unchanged');
    expectClose(cur(b2.id).boneTip!.x - cur(b2.id).pivot.x, vec2.x, 0.01, 'child local tip x unchanged');
    expectClose(cur(b2.id).boneTip!.y - cur(b2.id).pivot.y, vec2.y, 0.01, 'child local tip y unchanged');
    expectClose(cur(b3.id).boneTip!.x - cur(b3.id).pivot.x, vec3.x, 0.01, 'grandchild local tip x unchanged');
    expectClose(cur(b3.id).boneTip!.y - cur(b3.id).pivot.y, vec3.y, 0.01, 'grandchild local tip y unchanged');
  });
});

describe('scenario B23 — node-editing "bind to bone…" dialog', () => {
  it('pins the selected nodes to the picked bone/endpoint via the {a,b,t} override model', async () => {
    const [b1, b2] = placeParentedChain('left_arm', 2); // auto-bound by placement
    expect(partByLabel('left_arm').skin, 'auto-bound by placement').toBeTruthy();

    enterNodeMode('left_arm');
    const handles = Array.from(
      overlayEl().querySelectorAll('.node-handle[data-field="x"]'),
    ) as SVGElement[];
    expect(handles.length, 'node handles present').toBeGreaterThan(1);
    const p0 = clientCenterOf(handles[0]);
    click(p0.x, p0.y);

    const bindBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('#inspector button'))
      .find((b) => /bind to bone/.test(b.textContent ?? ''));
    expect(bindBtn, '"bind to bone…" button present with a node selected').toBeTruthy();
    expect(bindBtn!.disabled, 'enabled once a node is selected').toBe(false);
    bindBtn!.click();

    await waitFor(() => document.querySelector('.ui-dialog'), { message: 'bind dialog open' });
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('.ui-dialog select'));
    expect(selects.length, 'bone + endpoint selects').toBe(2);
    const [boneSel, endSel] = selects;
    boneSel.value = b2.id;
    endSel.value = 'origin';
    const ok = document.querySelector<HTMLButtonElement>('.ui-dialog-primary')!;
    ok.click();

    await waitFor(() => partByLabel('left_arm').skin?.overrides, { message: 'override applied' });
    const overrides = partByLabel('left_arm').skin!.overrides!;
    const pathId = Object.keys(overrides)[0];
    const cmdIndex = Object.keys(overrides[pathId])[0];
    const ov = overrides[pathId][cmdIndex];
    // "origin" of b2 (a child bone) is the joint shared with its PARENT (b1) — a = the
    // picked bone, b = that neighbor, t = 0.5 (an even blend across the shared joint).
    expect(ov.a).toBe(b2.id);
    expect(ov.b).toBe(b1.id);
    expectClose(ov.t, 0.5, 1e-9, 'even blend toward the neighbor');
    expect(canUndo(), 'the bind + pin round-trips through undo').toBe(true);
  });
});

describe('scenario B24 — full-chain IK on a 4-bone chain (the reported bug: EVERY joint bends)', () => {
  it('IK-dragging the wrist bends all four bones incl. the immediate parent, lengths byte-stable, one undo restores all rests', () => {
    // The user's exact complaint (screenshot: a 4-bone chain on an arm): the IK tool rotated
    // only the grabbed bone's two nearest ancestors — the grabbed bone and its immediate
    // parent moved as one rigid unit and the root never turned. FABRIK makes every joint
    // participate. MUTATION CHECK: the old two-joint solver leaves b1 (root) and b4 (grabbed)
    // unchanged, so those two assertions fail under it (only b2/b3 would move).
    const [b1, b2, b3, b4] = placeChain(LIMB, 4);
    expect(partByLabel(LIMB).skin!.bones.length, 'all four bones bound').toBe(4);

    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const bones = [b1, b2, b3, b4];
    const rot0 = bones.map((b) => b.rest.rotate);
    const len0 = bones.map(boneLen);

    // Grab the ACTUAL tip (Post-A Fix 2 is grab-point-relative — the grabbed point, not
    // always the tip, tracks the cursor — so "the tip lands on the pointer" below is only
    // a meaningful/precise check when the grab genuinely IS the tip).
    const from = boneTipClient(b4);
    const rootC = clientCenterOf(overlayEl().querySelector(`[data-part-id="${b1.id}"]`)!);
    const dxr = rootC.x - from.x, dyr = rootC.y - from.y; // toward the root
    const len = Math.hypot(dxr, dyr) || 1;
    // Curl the whole chain: pull the tip halfway back toward the root AND well off the chain
    // axis, so no single joint can reach the target alone — every one must turn.
    const toward = {
      x: from.x + dxr * 0.5 + (-dyr / len) * 55,
      y: from.y + dyr * 0.5 + (dxr / len) * 55,
    };
    gestureDrag(from, toward, { steps: 14 });

    const cur = (id: string) => state.doc!.parts.find((p) => p.id === id)!;
    bones.forEach((b, i) => {
      expect(Math.abs(cur(b.id).rest.rotate - rot0[i]), `bone ${i + 1} rotated (>0.5°)`)
        .toBeGreaterThan(0.5);
      expectClose(boneLen(cur(b.id)), len0[i], 1e-9, `bone ${i + 1} length byte-stable`);
    });

    // The grabbed TIP lands on the pointer ("the hand tracks the pointer") — tight
    // tolerance now that the grab point is precisely the tip (Post-A Fix 2 contract (a)).
    modelSelectPart(b4.id);
    repaint();
    const tip = clientCenterOf(overlayEl().querySelector('.bone-tip-handle')!);
    expectClose(Math.hypot(tip.x - toward.x, tip.y - toward.y), 0, 3, 'tip landed on the pointer');

    // One gesture = one checkpoint: a single undo restores EVERY bone's rest.
    expect(canUndo()).toBe(true);
    undo();
    bones.forEach((b, i) => {
      expectClose(cur(b.id).rest.rotate, rot0[i], 1e-9, `bone ${i + 1} rest restored by one undo`);
    });
  });
});

describe('scenario B25 — full-chain IK keys every bone at the playhead (Animate)', () => {
  it('IK-dragging the wrist in Animate writes a rotate keyframe on ALL FOUR bones', () => {
    const bones = placeChain(LIMB, 4); // placed in Edit
    const [b1, , , b4] = bones;

    setEditorMode('animate');
    state.currentTime = 0;
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    for (const b of bones) expect(clipTrack(b.id, 'rotate'), 'no rotate track pre-drag').toBeFalsy();

    const from = clientCenterOf(overlayEl().querySelector(`[data-part-id="${b4.id}"]`)!);
    const rootC = clientCenterOf(overlayEl().querySelector(`[data-part-id="${b1.id}"]`)!);
    const dxr = rootC.x - from.x, dyr = rootC.y - from.y;
    const len = Math.hypot(dxr, dyr) || 1;
    const toward = {
      x: from.x + dxr * 0.5 + (-dyr / len) * 55,
      y: from.y + dyr * 0.5 + (dxr / len) * 55,
    };
    gestureDrag(from, toward, { steps: 14 });

    // Every bone got a rotate track keyed at the playhead, differing from its rest (it turned).
    for (const b of bones) {
      const track = clipTrack(b.id, 'rotate');
      expect(track, `rotate track created for bone ${b.id}`).toBeTruthy();
      const key = track!.keyframes.find((k) => k.time === state.currentTime);
      expect(key, 'keyframe at the playhead').toBeTruthy();
      expect(Math.abs(key!.value - b.rest.rotate), 'keyed rotation differs from rest')
        .toBeGreaterThan(0.5);
    }
  });
});

// ---- Pen-tool bone chains (click-click placement replaces press-drag-release) ----

describe('scenario B26 — pen-tool chain: N clicks → N-1 connected bones, ONE undo, ONE auto-bind', () => {
  it('3 clicks + Escape makes 2 connected bones bound as one chain, and NOT bound until the chain ends', () => {
    const before = state.doc!.parts.length;
    modelSelectPart(null); // free-form chain (nothing selected)
    notify();
    renderPose();

    const pts = medialPoints(LIMB, 2); // 3 medial click points down the limb
    startBonePlacement();

    click(pts[0].x, pts[0].y); // click 1 — sets the chain origin, commits nothing
    expect(state.doc!.parts.length, 'origin click commits no bone').toBe(before);

    click(pts[1].x, pts[1].y); // click 2 — commits bone 1
    expect(state.doc!.parts.length, 'bone 1 committed').toBe(before + 1);
    // MUTATION CHECK (single auto-bind): binding must NOT have happened yet — it's
    // deferred to the chain end. If autoBind ran per-commit, the limb would be skinned here.
    expect(partByLabel(LIMB).skin ?? null, 'limb NOT bound mid-chain').toBeNull();

    click(pts[2].x, pts[2].y); // click 3 — commits bone 2
    expect(state.doc!.parts.length, 'bone 2 committed').toBe(before + 2);
    expect(partByLabel(LIMB).skin ?? null, 'still NOT bound mid-chain').toBeNull();

    pressKey('Escape'); // finish → real main.ts Escape tier → endBoneChain (auto-bind once)

    const bones = state.doc!.parts.slice(before);
    expect(bones.length, 'exactly 2 bones committed (3 clicks → 2 bones)').toBe(2);
    const [b1, b2] = bones;
    expect(b2.parentId, 'chain connected: bone 2 parents to bone 1').toBe(b1.id);
    expectClose(b2.pivot.x, b1.boneTip!.x, 0.3, 'shared joint x (child origin == parent tip)');
    expectClose(b2.pivot.y, b1.boneTip!.y, 0.3, 'shared joint y');

    // Auto-bind fired ONCE for the whole chain: the limb is skinned to BOTH bones, nothing else.
    const skin = partByLabel(LIMB).skin;
    expect(skin, 'limb auto-bound at chain end').toBeTruthy();
    expect(skin!.bones.map((b) => b.id), 'bound to the whole chain').toEqual([b1.id, b2.id]);
    expect(state.doc!.parts.filter((p) => p.skin).map((p) => p.label), 'only the limb bound')
      .toEqual([LIMB]);

    // MUTATION CHECK (one checkpoint): a SINGLE undo reverts BOTH bones AND the binding. Were
    // the checkpoint taken per-commit, one undo would leave bone 1 behind.
    expect(canUndo()).toBe(true);
    undo();
    expect(state.doc!.parts.length, 'both bones removed by one undo').toBe(before);
    expect(partByLabel(LIMB).skin ?? null, 'binding reverted in the same step').toBeNull();
  });
});

describe('scenario B27 — a lone origin click then Escape commits nothing (no checkpoint)', () => {
  it('one click + Escape leaves zero bones and takes no history step', () => {
    const before = state.doc!.parts.length;
    const couldUndoBefore = canUndo();
    modelSelectPart(null);
    notify();
    renderPose();

    startBonePlacement();
    const pts = medialPoints(LIMB, 1);
    click(pts[0].x, pts[0].y); // just the origin — no commit
    pressKey('Escape');

    expect(state.doc!.parts.length, 'no bone created from a single click').toBe(before);
    // MUTATION CHECK (deferred checkpoint): the origin click must not checkpoint — history
    // is untouched, so canUndo is exactly what it was before arming.
    expect(canUndo(), 'no history step for a bare origin click').toBe(couldUndoBefore);
  });
});

describe('scenario B28 — a live preview bone follows the cursor between clicks, gone after the end', () => {
  it('the .placing ghost + chain-origin marker appear while chaining and clear when the chain ends', () => {
    modelSelectPart(null);
    notify();
    renderPose();
    const pts = medialPoints(LIMB, 2);

    startBonePlacement();
    click(pts[0].x, pts[0].y); // origin set
    expect(overlayCount('.chain-origin'), 'origin marker after the first click').toBe(1);

    moveMouse(pts[1].x, pts[1].y); // move → preview segment from origin to cursor
    expect(overlayCount('.null-glyph.bone.placing'), 'preview ghost present between clicks').toBe(1);

    click(pts[1].x, pts[1].y); // commit bone 1 (cursor resets → ghost gone until next move)
    moveMouse(pts[2].x, pts[2].y);
    expect(overlayCount('.null-glyph.bone.placing'), 'preview follows onto the next segment').toBe(1);

    click(pts[2].x, pts[2].y);
    pressKey('Escape');
    expect(overlayCount('.null-glyph.bone.placing'), 'preview ghost gone after the chain ends').toBe(0);
    expect(overlayCount('.chain-origin'), 'origin marker gone after the chain ends').toBe(0);
  });
});

describe('scenario B29 — a double-click finishes the chain', () => {
  it('double-clicking the final joint commits its bone and ends chain mode', () => {
    modelSelectPart(null);
    notify();
    renderPose();
    const pts = medialPoints(LIMB, 2);

    startBonePlacement();
    click(pts[0].x, pts[0].y); // origin
    click(pts[1].x, pts[1].y); // bone 1
    const afterOne = state.doc!.parts.length;

    fullDblClick(pts[2].x, pts[2].y); // commits bone 2 (its 1st click), then ends (dblclick)

    expect(state.doc!.parts.length, 'the double-click placed one final bone').toBe(afterOne + 1);
    expect(overlayCount('.chain-origin'), 'chain ended — no origin marker').toBe(0);
    expect(partByLabel(LIMB).skin, 'the limb auto-bound at the double-click end').toBeTruthy();

    // A subsequent plain click adds no bone (chain truly ended, not still armed).
    const settled = state.doc!.parts.length;
    click(pts[0].x, pts[0].y);
    expect(state.doc!.parts.length, 'a click after the end commits nothing').toBe(settled);
  });
});

describe('scenario B30 — binding NESTED art keeps it under its group (hoisting regression)', () => {
  it("the user's repro: a chain on art inside a group leaves the art parented to the group, render-neutral", async () => {
    // girl_example.svg imports a real group "RightArm" wrapping an art part "Arm". The
    // regression: bind zeroed the art's parentId, hoisting the art (and its bones) out of
    // the group to root — "bones leave their parent object on assign". The fix keeps the
    // art parented (render forces transform='' for skinned parts, so the baked-in chain
    // isn't double-applied) and folds only the bone's own lost pose.
    await loadFixtureSvg('girl_example.svg', 'girl');
    const rightArm = state.doc!.parts.find((p) => p.label === 'RightArm' && p.kind === 'group')!;
    const arm = state.doc!.parts.find(
      (p) => p.label === 'Arm' && p.parentId === rightArm.id && p.kind === 'art',
    )!;
    expect(arm, 'nested Arm art present under the RightArm group').toBeTruthy();

    // Render-neutral baseline: screen-space samples of the Arm's rendered paths before bind.
    const armSamples = (): number[] => {
      const g = svgEl().querySelector(`[data-part-id="${arm.id}"]`)!;
      const out: number[] = [];
      for (const pe of Array.from(g.querySelectorAll('path')) as SVGPathElement[]) {
        const len = pe.getTotalLength();
        if (!(len > 0)) continue;
        const m = pe.getScreenCTM()!;
        for (let f = 0; f <= 1.0001; f += 0.2) {
          const q = pe.getPointAtLength(len * f);
          const sp = svgEl().createSVGPoint();
          sp.x = q.x; sp.y = q.y;
          const s = sp.matrixTransform(m);
          out.push(s.x, s.y);
        }
      }
      return out;
    };
    const before = armSamples();

    // Select the nested Arm, then draw a 2-bone chain (its clicks are down the arm's box —
    // with the art selected, auto-bind targets exactly it). Selection is preserved across
    // the chain, so the single end-of-chain bind skins the Arm.
    modelSelectPart(arm.id);
    notify();
    renderPose();
    // Well-separated CLIENT points near the arm (30 px gaps clear the MIN_BONE_LENGTH guard);
    // the chain geometry is irrelevant to the bind (targeting rule #2 binds the SELECTED art).
    const g = svgEl().querySelector(`[data-part-id="${arm.id}"]`) as SVGGElement;
    const r = g.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const bones = placeBoneChain([
      { x: cx, y: cy - 30 }, { x: cx, y: cy }, { x: cx, y: cy + 30 },
    ]); // selection (the Arm) preserved → bind targets it
    expect(bones.length, 'a 2-bone chain was placed').toBe(2);

    const armAfter = state.doc!.parts.find((p) => p.id === arm.id)!;
    expect(armAfter.skin, 'Arm bound by the chain').toBeTruthy();
    expect(armAfter.parentId, 'Arm STILL under the RightArm group (not hoisted to root)')
      .toBe(rightArm.id);
    expect(bones[0].parentId, 'bone 1 parented to the Arm (hierarchy-as-assignment)').toBe(arm.id);
    expect(bones[1].parentId, 'bone 2 parented to bone 1').toBe(bones[0].id);

    // Render-neutral: the nested art did not move a pixel across placement + bind.
    const after = armSamples();
    let drift = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      drift = Math.max(drift, Math.abs(before[i] - after[i]));
    }
    expectClose(drift, 0, 0.05, 'nested art render-neutral across bind (≤0.05px)');
  });
});

describe('scenario GB — Group-level auto-bind (the reported bug: a chain on Pip\'s body only bound ONE piece)', () => {
  /**
   * Screen-space bounding-rect corners of every path in ONE part (by id, not label —
   * Pip's body imports as nested art-in-art and BOTH parts share the label "body", so a
   * label-keyed lookup can't distinguish them). Deliberately NOT arc-length-fraction
   * point sampling (`renderScreenSamples`/`armSamples` above, `getTotalLength`/
   * `getPointAtLength`): those reparametrize "percent along the curve" using the CURRENT
   * `d` geometry's own arc length, which is NOT invariant across a bake that folds a
   * NON-UNIFORM scale into the coordinates — Pip's outer body carries a real x≠y baked
   * squash (`matrix(1,0,0,0.92699903,…)`), so pre-bake (local, pre-squash arc length) vs
   * post-bake (baked, squash-shaped arc length) samples land at genuinely different
   * points along the SAME rendered curve, showing several px of false "drift" even though
   * the actual painted pixels are unchanged (verified by hand: the baked matrix applied
   * to the path's own explicit M/C vertices reproduces the post-bind `d` exactly).
   * `getBoundingClientRect` is a true screen measurement with no such artifact.
   */
  function pathScreenCorners(id: string): number[] {
    const g = svgEl().querySelector(`[data-part-id="${id}"]`) as SVGGElement;
    const out: number[] = [];
    for (const pe of Array.from(g.querySelectorAll('path')) as SVGPathElement[]) {
      const r = pe.getBoundingClientRect();
      out.push(r.x, r.y, r.x + r.width, r.y + r.height);
    }
    return out;
  }
  function maxDrift(a: number[], b: number[]): number {
    let d = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
  }

  /** Pip's "body" is nested art-in-art: an outer "body" part (1 own path — its drop
   *  shadow) parenting an inner "body" part (3 own paths — white_pill_body,
   *  bottom_half_red, outline). Both share the label "body"; distinguish by parentId. */
  function pipBodyParts() {
    const outer = state.doc!.parts.find((p) => p.label === 'body' && p.parentId === null)!;
    const inner = state.doc!.parts.find((p) => p.label === 'body' && p.parentId === outer.id)!;
    expect(outer, 'outer body part present').toBeTruthy();
    expect(inner, 'inner body part present').toBeTruthy();
    return { outer, inner };
  }

  /** Select the outer body and place a 2-bone chain down its rendered box. */
  function placeChainOnBody(outerId: string) {
    modelSelectPart(outerId);
    notify();
    renderPose();
    const g = svgEl().querySelector(`[data-part-id="${outerId}"]`) as SVGGElement;
    const r = g.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return placeBoneChain([{ x: cx, y: cy - 30 }, { x: cx, y: cy }, { x: cx, y: cy + 30 }]);
  }

  it('binds EVERY body piece (outer shadow + inner pill/red/outline), each render-neutral', () => {
    const { outer, inner } = pipBodyParts();
    expect(outer.paths.length, 'outer body carries its own drop-shadow path').toBe(1);
    expect(inner.paths.length, 'inner body carries white_pill_body/bottom_half_red/outline').toBe(3);
    const outerBefore = pathScreenCorners(outer.id);
    const innerBefore = pathScreenCorners(inner.id);

    const bones = placeChainOnBody(outer.id);
    expect(bones.length, 'a 2-bone chain was placed').toBe(2);

    const outerAfter = state.doc!.parts.find((p) => p.id === outer.id)!;
    const innerAfter = state.doc!.parts.find((p) => p.id === inner.id)!;
    expect(outerAfter.skin, 'outer body (shadow) bound').toBeTruthy();
    expect(innerAfter.skin, 'inner body (pill/red/outline) bound').toBeTruthy();
    const boneIds = bones.map((b) => b.id).sort();
    expect(outerAfter.skin!.bones.map((b) => b.id).sort(), 'outer bound to the whole chain').toEqual(boneIds);
    expect(innerAfter.skin!.bones.map((b) => b.id).sort(), 'inner bound to the whole chain').toEqual(boneIds);
    // Parenting is untouched by binding (hierarchy-as-assignment): inner still under outer.
    expect(innerAfter.parentId).toBe(outer.id);

    expectClose(maxDrift(outerBefore, pathScreenCorners(outer.id)), 0, 0.05, 'outer body render-neutral across bind');
    expectClose(maxDrift(innerBefore, pathScreenCorners(inner.id)), 0, 0.05, 'inner body render-neutral across bind');
  });

  it('rotating a bone deforms EVERY bound body piece coherently', () => {
    const { outer, inner } = pipBodyParts();
    const bones = placeChainOnBody(outer.id);
    const innerBeforeD = state.doc!.parts.find((p) => p.id === inner.id)!.paths.map((p) => p.d).join('|');

    // Grab the root bone's tip and drag it — reshapes the whole chain, LBS-deforming
    // every part bound to it.
    modelSelectPart(bones[0].id);
    notify();
    renderPose();
    const tipEl = overlayEl().querySelector('[data-role="bone-tip"]') as SVGElement;
    expect(tipEl, 'root bone tip handle present').toBeTruthy();
    const from = clientCenterOf(tipEl);
    gestureDrag(from, { x: from.x + 40, y: from.y - 25 });

    const renderedD = (id: string) => Array.from(
      svgEl().querySelector(`[data-part-id="${id}"]`)!.querySelectorAll('path'),
    ).map((p) => p.getAttribute('d') ?? '').join('|');
    const outerRenderedD = renderedD(outer.id);
    const innerRenderedD = renderedD(inner.id);
    const outerBindD = state.doc!.parts.find((p) => p.id === outer.id)!.paths.map((p) => p.d).join('|');
    const innerBindD = state.doc!.parts.find((p) => p.id === inner.id)!.paths.map((p) => p.d).join('|');

    expect(outerRenderedD, 'outer rendered geometry deformed by the bone drag').not.toBe(outerBindD);
    expect(innerRenderedD, 'inner rendered geometry deformed by the bone drag').not.toBe(innerBindD);
    // The model's own (bind-pose) `d` never mutates at render time — only the DOM attr.
    expect(innerBindD, "inner's stored bind-pose d unchanged by rendering").toBe(innerBeforeD);
  });

  it('one undo clears the chain AND every binding it created', () => {
    const before = state.doc!.parts.length;
    const { outer, inner } = pipBodyParts();
    const bones = placeChainOnBody(outer.id);
    expect(state.doc!.parts.length).toBe(before + bones.length);
    expect(canUndo()).toBe(true);

    undo();

    expect(state.doc!.parts.length, 'the whole chain removed by one undo').toBe(before);
    const outerAfter = state.doc!.parts.find((p) => p.id === outer.id)!;
    const innerAfter = state.doc!.parts.find((p) => p.id === inner.id)!;
    expect(outerAfter.skin, 'outer binding undone').toBeFalsy();
    expect(innerAfter.skin, 'inner binding undone').toBeFalsy();
  });

  it('unbinding ONE part leaves the others bound (no cross-part coupling)', () => {
    const { outer, inner } = pipBodyParts();
    placeChainOnBody(outer.id);
    expect(state.doc!.parts.find((p) => p.id === outer.id)!.skin).toBeTruthy();
    expect(state.doc!.parts.find((p) => p.id === inner.id)!.skin).toBeTruthy();

    modelSelectPart(outer.id);
    notify();
    unbindSelectedSkin();

    const outerAfter = state.doc!.parts.find((p) => p.id === outer.id)!;
    const innerAfter = state.doc!.parts.find((p) => p.id === inner.id)!;
    expect(outerAfter.skin, 'outer unbound').toBeFalsy();
    expect(innerAfter.skin, 'inner STILL bound — unbinding one part is independent').toBeTruthy();
  });

  it('a genuine kind:"group" part (Ctrl+G) also expands to every member, not just one', () => {
    // Construct a REAL group via the actual grouping gesture (click, Shift+click,
    // groupAction — same as groupHandles.test.ts's makeGroup), independent of Pip's
    // nested-art-in-art body: this exercises expandBindTarget's `kind === 'group'`
    // branch specifically, not the nested-art-in-art one.
    const laId = partByLabel('left_arm').id;
    const raId = partByLabel('right_arm').id;
    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    groupAction();
    const group = state.doc!.parts.find((pt) => pt.kind === 'group')!;
    expect(group, 'a real group part was created').toBeTruthy();
    expect(state.selectedPartId).toBe(group.id);

    // The group has no rendered geometry of its own (partless), so its bbox comes from
    // its descendants — place the chain anywhere reasonable on the canvas; group-kind
    // targeting binds every member regardless of where the bones land (no coverage test).
    const svg = svgEl().getBoundingClientRect();
    const cx = svg.left + svg.width / 2, cy = svg.top + svg.height / 2;
    const bones = placeBoneChain([{ x: cx, y: cy - 30 }, { x: cx, y: cy }, { x: cx, y: cy + 30 }]);
    expect(bones.length, 'a 2-bone chain was placed').toBe(2);
    expect(bones[0].parentId, 'chain root parented to the group').toBe(group.id);

    const leftAfter = state.doc!.parts.find((p) => p.id === laId)!;
    const rightAfter = state.doc!.parts.find((p) => p.id === raId)!;
    expect(leftAfter.skin, 'left_arm bound via the group').toBeTruthy();
    expect(rightAfter.skin, 'right_arm bound via the group').toBeTruthy();
    expect(leftAfter.parentId, 'left_arm stays under the group (hierarchy-as-assignment)').toBe(group.id);
    expect(rightAfter.parentId, 'right_arm stays under the group').toBe(group.id);
  });
});
