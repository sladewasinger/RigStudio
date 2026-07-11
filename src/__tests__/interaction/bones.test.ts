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

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import {
  selectPart as modelSelectPart, setKeyframe, notify,
  serializeDoc, deserializeDoc,
} from '../../core/model';
import { startBonePlacement, renderPose, setNodeBinding, recomputeAutoWeights } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, gestureDrag, click,
  clientCenterOf, overlayEl, overlayCount, expectClose, setEditorMode, repaint,
  enterNodeMode, medialPoints, clientPointOnPart, svgEl, selectByLabel, pressKey,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Place a bone by a real press-drag-release gesture; returns the created bone part. */
function placeBoneGesture(from: { x: number; y: number }, to: { x: number; y: number }) {
  startBonePlacement();
  gestureDrag(from, to);
  return state.doc!.parts[state.doc!.parts.length - 1];
}

/**
 * Place an n-bone chain down a limb's MEDIAL axis: bone 1 free-form (nothing selected
 * → geometric auto-bind), the rest as child bones pressed at an OFFSET from the parent
 * tip (so "child origin anchored at the parent tip" is distinguishable from "origin at
 * the press point" — only the drag END should matter for a child).
 */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  const pts = medialPoints(label, n);
  modelSelectPart(null);
  notify();
  renderPose();
  const bones: ReturnType<typeof partByLabel>[] = [];
  for (let k = 1; k <= n; k++) {
    const press = k === 1 ? pts[0] : { x: pts[k - 1].x + 28, y: pts[k - 1].y + 18 };
    bones.push(placeBoneGesture(press, pts[k]));
  }
  return bones;
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

describe('scenario B4 — IK through the bound chain (grab the tip bone glyph)', () => {
  it('IK-dragging the chain end rotates both ancestor joints and deforms the art', () => {
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
    expect(Math.abs(b1After.rest.rotate - rot1Before), 'root joint rotated').toBeGreaterThan(0.5);
    expect(Math.abs(b2After.rest.rotate - rot2Before), 'mid joint rotated').toBeGreaterThan(0.5);
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
  // RE-SPEC (v2.13 freeze mode): both a child bone's origin and a parent bone's tip are
  // shared JOINTS, so both are freeze-gated. Press Y to enter freeze mode before dragging
  // them; the shared-joint coupling the scenario verifies is otherwise unchanged.
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

    const bent = Math.abs(cur(b1.id).rest.rotate - r1) > 0.5
      || Math.abs(cur(b2.id).rest.rotate - r2) > 0.5;
    expect(bent, 'IK rotated at least one chain joint').toBe(true);
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
